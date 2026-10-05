// The share helper: a small process that makes every file call on one storage location for the
// server, so that the server never waits on a share (share-calls.mjs starts it and says why).
//
//   node cctv/share-helper.mjs <location id> <location folder>     (forked, with an IPC channel)
//   in:  { n, op, args }                       op: see share-ops.mjs
//   out: { n, progress: true }                 after each file call that came back
//        { n, ok: true, result } | { n, ok: false, error: { message, code } }
//
// It ends when the server does (its channel closes), and it loads nothing of the server's but the
// file ops, so it stays small however large the server grows: 54 MB RSS and 11 threads on the
// production VM (2026-09-29).
import { closeSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { makeShareOps } from './share-ops.mjs'

/**
 * Closes the TCP and UDP sockets this process was born with. The TVT SDK opens its sockets without
 * close-on-exec, so every child the server forks inherits its NVR connections, and a connection the
 * server closes stays open for as long as the child lives (perf report processes.md P3, 2026-09-29:
 * one control connection was open in four processes). For a helper that lives as long as the
 * server, that would be for good. It opens no socket of its own; its channel to the server is a
 * Unix socket, which is not in /proc/net/tcp or udp, so it is not touched. Linux only.
 */
function closeInheritedSockets() {
  if (process.platform !== 'linux') return 0
  const inet = new Set()
  for (const f of ['tcp', 'tcp6', 'udp', 'udp6']) {
    let text = ''
    try {
      text = readFileSync(`/proc/self/net/${f}`, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n').slice(1)) {
      const inode = line.trim().split(/\s+/)[9]
      if (inode && inode !== '0') inet.add(inode)
    }
  }
  let closed = 0
  for (const fd of readdirSync('/proc/self/fd')) {
    if (!(Number(fd) > 2)) continue
    try {
      const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/self/fd/${fd}`))
      if (m && inet.has(m[1])) {
        closeSync(Number(fd))
        closed++
      }
    } catch {}
  }
  return closed
}

try {
  closeInheritedSockets()
} catch (e) {
  console.warn(`[share-helper] could not close inherited sockets: ${e.message}`)
}

const [id, root] = process.argv.slice(2)
const ops = makeShareOps({ id, root })

const send = (m) => {
  try {
    if (process.connected) process.send(m)
  } catch {} // the server has gone: 'disconnect' below ends this process
}

process.on('message', async (m) => {
  if (!m || !Number.isInteger(m.n)) return
  const tick = () => send({ n: m.n, progress: true })
  try {
    if (!Object.hasOwn(ops, m.op)) throw Object.assign(new Error(`EBADOP: no such call: ${m.op}`), { code: 'EBADOP' })
    send({ n: m.n, ok: true, result: await ops[m.op](m.args ?? {}, tick) })
  } catch (e) {
    send({ n: m.n, ok: false, error: { message: e.message, code: e.code ?? null } })
  }
})
// the server has gone (or stopped this helper): nothing is left to answer
process.on('disconnect', () => process.exit(0))
