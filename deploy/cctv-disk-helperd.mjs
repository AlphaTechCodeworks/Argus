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
//   {"op":"netmount","proto":"smb"|"nfs","server":"...","share":"...","subdir":"...","id":"...",
//    "user":"...","pass":"...","mode":"add"|"test"}   (subdir: the folder inside the share, or "")
//   {"op":"netunmount","id":"..."}
// Answer: the helper's JSON lines as it prints them (progress for prepare and netmount), then
// {"exit":<code>}. Anything else is refused ({"error":"refused: ..."} then {"exit":2}); nothing
// else can be run. Only one prepare at a time, and only one mount job at a time. A prepare goes on
// when the client hangs up (stopping mkfs halfway helps nobody); the helper re-checks the disk
// (not the system disk, nothing mounted, not in a pool/LVM/RAID, serial matches) immediately
// before it erases anything.
//
// The NAS user name and password are the only fields that never become arguments: they go to the
// helper on its stdin, because /proc/<pid>/cmdline is readable by every user on the machine. They
// are never logged here either, and parseRequest keeps them out of the argument list by design.
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
// A NAS share: the same allowlists the helper script checks again before it writes or runs
// anything. An IPv4 address or a host name; one SMB share name with no slash, backslash or space;
// an NFS export whose every part starts with a letter or a digit (which rules out "." and "..",
// so no traversal is possible); an id that is safe as a file name and as part of a unit name.
const IPV4 = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
// A share name, or one folder name inside it. A space is allowed (real shares have them:
// "CCTV Backup"), but the name must start with a letter or a digit and must not end in a space:
// that rules out ".", "..", hidden names and the trailing space systemd would strip from What=.
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+&-]{0,63}$/
const NFS_EXPORT = /^(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){1,8}$/
const isName = (v) => typeof v === 'string' && NAME.test(v) && !v.endsWith(' ')
/** '' or a relative folder inside the share, at most four parts deep. */
const isSubdir = (v) => typeof v === 'string' && (v === '' || (v.length <= 255 && v.split('/').length <= 4 && v.split('/').every(isName)))
const SHARE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const NAS_USER = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,31}\\)?[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/
const PROTOS = ['smb', 'nfs']
const MODES = ['add', 'test']
const MAX_PASS = 256
const MAX_REQUEST = 4096

// A host name's last part may not be all digits: "999.1.1.1" looks like an address but is not one.
const isServer = (v) => typeof v === 'string' && v.length <= 253 && (IPV4.test(v) || (HOSTNAME.test(v) && !/^\d+$/.test(v.split('.').at(-1))))

/**
 * One request line -> what to run: { args } for the helper, plus `stdin` when there is a secret
 * (the NAS user name and password, one line each). Secrets are never put in args.
 * @throws {Error} "refused: ..."
 */
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
    return { args: ['list'] }
  }
  if (r.op === 'prepare') {
    if (keys !== 'dev,fs,op,serial') throw new Error('refused: prepare takes exactly dev, serial, fs')
    if (typeof r.dev !== 'string' || !DEV.test(r.dev)) throw new Error('refused: dev must be a whole disk such as /dev/sdb')
    if (typeof r.serial !== 'string' || !SERIAL.test(r.serial)) throw new Error('refused: odd serial number')
    if (!FS.includes(r.fs)) throw new Error('refused: fs must be xfs or ext4')
    return { args: ['prepare', r.dev, r.serial, r.fs] }
  }
  if (r.op === 'netmount') {
    if (keys !== 'id,mode,op,pass,proto,server,share,subdir,user') throw new Error('refused: netmount takes exactly proto, server, share, subdir, id, user, pass, mode')
    if (!PROTOS.includes(r.proto)) throw new Error('refused: proto must be smb or nfs')
    if (!MODES.includes(r.mode)) throw new Error('refused: mode must be add or test')
    if (!isServer(r.server)) throw new Error('refused: server must be an IPv4 address or a host name')
    if (r.proto === 'smb' ? !isName(r.share) : !(typeof r.share === 'string' && r.share.length <= 255 && NFS_EXPORT.test(r.share))) {
      throw new Error(r.proto === 'smb' ? 'refused: odd share name' : 'refused: odd export path (/export/path)')
    }
    if (!isSubdir(r.subdir)) throw new Error('refused: odd folder inside the share')
    if (typeof r.id !== 'string' || !SHARE_ID.test(r.id)) throw new Error('refused: odd share id (lower-case letters, digits and - only)')
    if (typeof r.user !== 'string' || (r.user !== '' && !NAS_USER.test(r.user))) throw new Error('refused: odd user name')
    // the password is never inspected beyond its length and shape: any control character would
    // break the two-line stdin protocol, and nothing else about it is this service's business
    if (typeof r.pass !== 'string' || r.pass.length > MAX_PASS) throw new Error(`refused: the password must be text of at most ${MAX_PASS} characters`)
    if (/[\r\n\0]/.test(r.pass)) throw new Error('refused: the password must not contain line breaks')
    if (r.proto === 'smb' && r.user === '') throw new Error('refused: SMB needs a user name')
    return { args: ['netmount', r.proto, r.server, r.share, r.id, r.mode, r.subdir], stdin: `${r.user}\n${r.pass}\n` }
  }
  if (r.op === 'netunmount') {
    if (keys !== 'id,op') throw new Error('refused: netunmount takes exactly id')
    if (typeof r.id !== 'string' || !SHARE_ID.test(r.id)) throw new Error('refused: odd share id (lower-case letters, digits and - only)')
    return { args: ['netunmount', r.id] }
  }
  throw new Error('refused: unknown op (only list, prepare, netmount and netunmount)')
}

/**
 * Serves requests on a listening (or to-be-listening) net.Server.
 * @param {import('node:net').Server} server
 * @param {{ helper?: string, env?: object, requestTimeoutMs?: number, log?: (s: string) => void }} [opts]
 *   tests only: another helper / environment (the installed service always uses the defaults)
 */
export function serve(server, { helper = HELPER, env = SAFE_ENV, requestTimeoutMs = 5000, log = (s) => console.log(s) } = {}) {
  let preparing = null // the dev being prepared
  let mounting = null // the share id being mounted or unmounted
  const state = { preparing: () => preparing, mounting: () => mounting }
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
      let req
      try {
        req = parseRequest(buf.slice(0, i))
      } catch (e) {
        return refuse(e.message)
      }
      const args = req.args
      const [op] = args
      const isMount = op === 'netmount' || op === 'netunmount'
      if (op === 'prepare') {
        if (preparing) {
          send({ step: 'start', state: 'failed', message: `another drive (${preparing}) is being prepared; wait for it to finish` })
          return finish(4)
        }
        preparing = args[1]
        log(`[cctv-disk] prepare ${args[1]} serial ${args[2]} as ${args[3]}`)
      }
      if (isMount) {
        if (mounting) {
          send({ step: 'start', state: 'failed', message: `another share (${mounting}) is being mounted; wait for it to finish` })
          return finish(4)
        }
        // the share id, the server and the share name only: never the user name or the password
        mounting = op === 'netmount' ? args[4] : args[1]
        log(op === 'netmount' ? `[cctv-disk] netmount ${args[4]}: ${args[1]} ${args[2]} ${args[3]} (${args[5]})` : `[cctv-disk] netunmount ${args[1]}`)
      }
      run(helper, args, env, send, req.stdin).then((code) => {
        if (op === 'prepare') {
          preparing = null
          log(`[cctv-disk] prepare ${args[1]}: exit ${code}`)
        }
        if (isMount) {
          const id = mounting
          mounting = null
          log(`[cctv-disk] ${op} ${id}: exit ${code}`)
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

/**
 * Runs the helper; each stdout line goes to send(). Resolves to its exit code. `stdin`, when
 * given, is the secret (the NAS user name and password): it goes down the pipe and nowhere else.
 */
function run(helper, args, env, send, stdin) {
  return new Promise((resolve) => {
    const p = spawn(helper, args, { env: { ...env }, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    if (stdin !== undefined) {
      p.stdin.on('error', () => {}) // the helper may refuse and exit before reading
      p.stdin.end(stdin)
    }
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
