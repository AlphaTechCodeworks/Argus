#!/usr/local/bin/node
// CCTV disk helper service: the ONLY root part of the CCTV VMS. Runs as cctv-disk-helper.service
// (root), started by cctv-disk-helper.socket, which listens on /run/cctv-disk/helper.sock
// (root:cctv-disk 0660: only the cctv service, which has the cctv-disk group, can connect).
// Installed by deploy/install-ubuntu.sh to /usr/local/lib/cctv/cctv-disk-helperd.mjs; the work is
// done by the checked script /usr/local/sbin/cctv-disk-helper (deploy/cctv-disk-helper).
//
// Protocol: one request per connection, one JSON line (at most 4 KB, within 5 s):
//   {"op":"list"}
//   {"op":"prepare","dev":"/dev/sdb","serial":"NAABC123","fs":"xfs"|"ext4"}
// Answer: the helper's JSON lines as it prints them (progress for prepare), then {"exit":<code>}.
// Anything else is refused ({"error":"refused: ..."} then {"exit":2}); nothing else can be run.
// Only one prepare at a time. A prepare goes on when the client hangs up (stopping mkfs halfway
// helps nobody); the helper re-checks the disk (not the system disk, nothing mounted, not in a
// pool/LVM/RAID, serial matches) immediately before it erases anything.
//
// The helper always gets a fixed environment (never the caller's, never CCTV_DISK_DRYRUN):
// the dry-run and fake-tree settings exist for tests only, which call serve() with their own.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { pathToFileURL } from 'node:url'

export const HELPER = '/usr/local/sbin/cctv-disk-helper'
export const SAFE_ENV = Object.freeze({ PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' })
const DEV = /^\/dev\/(sd[a-z]{1,2}|vd[a-z]{1,2}|nvme[0-9]{1,2}n[0-9]{1,2}|mmcblk[0-9]{1,2})$/
const SERIAL = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/
const FS = ['xfs', 'ext4']
const MAX_REQUEST = 4096

/** One request line -> the helper's arguments. @throws {Error} "refused: ..." */
export function parseRequest(line) {
  let r
  try {
    r = JSON.parse(line)
  } catch {
    throw new Error('refused: not JSON')
  }
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('refused: not a request object')
  const keys = Object.keys(r).sort().join()
  if (r.op === 'list') {
    if (keys !== 'op') throw new Error('refused: list takes no arguments')
    return ['list']
  }
  if (r.op === 'prepare') {
    if (keys !== 'dev,fs,op,serial') throw new Error('refused: prepare takes exactly dev, serial, fs')
    if (typeof r.dev !== 'string' || !DEV.test(r.dev)) throw new Error('refused: dev must be a whole disk such as /dev/sdb')
    if (typeof r.serial !== 'string' || !SERIAL.test(r.serial)) throw new Error('refused: odd serial number')
    if (!FS.includes(r.fs)) throw new Error('refused: fs must be xfs or ext4')
    return ['prepare', r.dev, r.serial, r.fs]
  }
  throw new Error('refused: unknown op (only list and prepare)')
}

/**
 * Serves requests on a listening (or to-be-listening) net.Server.
 * @param {import('node:net').Server} server
 * @param {{ helper?: string, env?: object, requestTimeoutMs?: number, log?: (s: string) => void }} [opts]
 *   tests only: another helper / environment (the installed service always uses the defaults)
 */
export function serve(server, { helper = HELPER, env = SAFE_ENV, requestTimeoutMs = 5000, log = (s) => console.log(s) } = {}) {
  let preparing = null // the dev being prepared
  const state = { preparing: () => preparing }
  server.on('connection', (sock) => {
    const send = (o) => {
      if (!sock.destroyed && sock.writable) sock.write(typeof o === 'string' ? `${o}\n` : `${JSON.stringify(o)}\n`)
    }
    const finish = (code) => {
      send({ exit: code })
      sock.end()
    }
    const refuse = (message) => {
      send({ error: message })
      finish(2)
    }
    sock.on('error', () => {})
    sock.setEncoding('utf8')
    let buf = ''
    let got = false
    const timer = setTimeout(() => !got && refuse('refused: no request within the time limit'), requestTimeoutMs)
    const onData = (chunk) => {
      buf += chunk
      const i = buf.indexOf('\n')
      if (i < 0 && buf.length <= MAX_REQUEST) return
      got = true
      clearTimeout(timer)
      sock.off('data', onData)
      sock.pause() // one request per connection: anything after it is ignored
      if (i < 0 || i > MAX_REQUEST) return refuse('refused: request too long')
      let args
      try {
        args = parseRequest(buf.slice(0, i))
      } catch (e) {
        return refuse(e.message)
      }
      if (args[0] === 'prepare') {
        if (preparing) {
          send({ step: 'start', state: 'failed', message: `another drive (${preparing}) is being prepared; wait for it to finish` })
          return finish(4)
        }
        preparing = args[1]
        log(`[cctv-disk] prepare ${args[1]} serial ${args[2]} as ${args[3]}`)
      }
      run(helper, args, env, send).then((code) => {
        if (args[0] === 'prepare') {
          preparing = null
          log(`[cctv-disk] prepare ${args[1]}: exit ${code}`)
        }
        finish(code)
      })
    }
    sock.on('data', onData)
    sock.on('end', () => {
      if (!got) {
        clearTimeout(timer)
        got = true
        sock.end()
      }
    })
  })
  return state
}

/** Runs the helper; each stdout line goes to send(). Resolves to its exit code. */
function run(helper, args, env, send) {
  return new Promise((resolve) => {
    const p = spawn(helper, args, { env: { ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (c) => {
      out += c
      let i
      while ((i = out.indexOf('\n')) >= 0) {
        send(out.slice(0, i))
        out = out.slice(i + 1)
      }
    })
    p.stderr.on('data', (c) => (err = (err + c).slice(-2000)))
    p.on('error', (e) => {
      send({ step: 'start', state: 'failed', message: `cannot run the disk helper: ${e.message}` })
      resolve(127)
    })
    p.on('close', (code) => {
      if (out) send(out)
      if (code && err.trim()) send({ step: 'helper', state: 'failed', message: err.trim().split('\n').at(-1) })
      resolve(code ?? 1)
    })
  })
}

// as the service: the listening socket comes from systemd (socket activation, fd 3)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.LISTEN_FDS !== '1' || process.env.LISTEN_PID !== String(process.pid)) {
    console.error('cctv-disk-helperd: start it through cctv-disk-helper.socket (systemd socket activation)')
    process.exit(2)
  }
  if (process.getuid?.() !== 0) {
    console.error('cctv-disk-helperd: must run as root')
    process.exit(2)
  }
  const server = createServer()
  const state = serve(server)
  server.listen({ fd: 3 }, () => console.log('[cctv-disk] ready'))
  // idle a minute (no connection, no prepare): exit; systemd keeps the socket and starts the
  // (possibly updated) helper again on the next request
  let idleSince = Date.now()
  setInterval(() => {
    server.getConnections((e, n) => {
      if (e || n > 0 || state.preparing()) return void (idleSince = Date.now())
      if (Date.now() - idleSince > 60_000) process.exit(0)
    })
  }, 5000)
}
