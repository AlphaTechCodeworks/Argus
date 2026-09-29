// The server's side of the share helper: every file call on a storage location that the server
// must not make itself goes to a small process of its own (share-helper.mjs), one per location,
// started once and kept.
//
// Why. A share whose SMB session has gone stale takes any file call made on it and never gives it
// back, and the process that made it cannot even be killed: on 2026-09-26 that froze the whole server
// twice. So since then the server did not touch a share to learn its health; it forked a checker
// every 30 s (location-probe.mjs). But a fork copies the server's memory map, 640 MB then: /healthz
// answered 19-33 ms late at the moment of the fork on production (about 35 ms by verify-6's estimate),
// and the child spent 90 ms of CPU starting Node for a 1 ms check (perf report R6 and its check
// verify-6, 2026-09-29). And the deletion and time-lapse jobs (Tasks 3-4) did their NAS file work on
// the main thread, minutes of it per run once the NAS is full or fullDays is lowered. Now one helper
// per location answers the check every 30 s, and does those jobs' file calls. Measured on the
// production VM in a test process of about production's size (330 MB of JS heap, 275 MB of Buffers,
// but without the server's threads and libraries): the longest main-thread stretch of one check went
// from 10-11 ms (p50; max 12.8) with a fork to 0.8 ms (max 2.6) with the helper. The helper itself is
// 54 MB and 11 threads.
//
// The rules, from 2026-09-26 and verify-6 (6a):
//  - no answer within the answer time (SHARE_ANSWER_MS by default: the time ONE file call may take;
//    the helper reports each one that comes back, and that restarts the clock) -> the share is "not
//    answering": every call in flight fails, the helper gets SIGKILL, and the share is announced
//    stuck (storage.mjs marks it down at once, and the outside watcher remounts it: healthz shares);
//  - SIGKILL does not end a process inside a call on a stale share. Until the old helper has really
//    exited, no call goes to that share and no new helper is started (each would get stuck the same
//    way, one more per timeout): calls fail at once, "a check has been stuck for N s";
//  - answers from a helper already given up on are ignored;
//  - a helper that ends by itself (a crash) fails its calls as "stopped", not "not answering", and the
//    next call starts a new one.
// Callers send one call at a time per job and keep batches small (the helper has 4 threads for file
// calls); nothing is queued here.
import { fork } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'

/** How long a file call on a share gets to come back before the share is called down. */
export const SHARE_ANSWER_MS = 10_000

let HELPER = join(import.meta.dirname, 'share-helper.mjs')
let forkFn = fork
let answerMs = SHARE_ANSWER_MS
let forks = 0
let seq = 0

/** The answer time now (SHARE_ANSWER_MS; shorter only in tests). */
export const shareAnswerMs = () => answerMs

const LABEL = { probe: 'check', statfs: 'free-space check', stat: 'file check', readdir: 'folder listing', unlink: 'deletion', rmdir: 'folder removal', thin: 'time-lapse rewrite', thinSwap: 'time-lapse rewrite', thinCommit: 'time-lapse rewrite', thinAbort: 'time-lapse rewrite', thinRecover: 'time-lapse recovery' }

const helpers = new Map() // key -> { key, id, root, child, calls: Map(n -> call), stuck: { since, op, child }|null }
const stuckListeners = new Set()

const keyOf = (loc) => `${loc.id}\n${resolve(loc.path)}`
const fail = (code, message) => Object.assign(new Error(message), { code })

function helperFor(loc) {
  const key = keyOf(loc)
  let h = helpers.get(key)
  if (!h) helpers.set(key, (h = { key, id: loc.id, root: resolve(loc.path), child: null, calls: new Map(), stuck: null }))
  return h
}

function start(h) {
  const child = forkFn(HELPER, [h.id, h.root], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    execArgv: [],
    // 4 threads for its file calls: it is one share's, and one call at a time per job
    env: { ...process.env, UV_THREADPOOL_SIZE: '4' },
    serialization: 'json'
  })
  forks++
  h.child = child
  child.on('message', (m) => answer(h, child, m))
  child.on('exit', (code, signal) => ended(h, child, code, signal))
  // 'error' is also a kill or a send that failed: only one that was never started has ended
  child.on('error', (e) => {
    if (!child.pid) ended(h, child, null, null, e)
    else console.warn(`[storage] ${h.root}: share helper (pid ${child.pid}): ${e.message}`)
  })
  // never what keeps the server running; a call waiting on it keeps its own timer
  child.unref?.()
  child.channel?.unref?.()
}

function settle(h, c) {
  clearTimeout(c.timer)
  h.calls.delete(c.n)
}

function answer(h, child, m) {
  if (child !== h.child || !m) return // from a helper already given up on: ignored
  const c = h.calls.get(m.n)
  if (!c) return
  if (m.progress) {
    // one more file call came back: the share is slow perhaps, but not stuck
    clearTimeout(c.timer)
    c.lastAt = Date.now()
    c.timer = setTimeout(() => noAnswer(h, c), c.timeoutMs)
    return
  }
  settle(h, c)
  if (m.ok) c.resolve(m.result)
  else c.reject(fail(m.error?.code ?? 'ESHAREOP', m.error?.message ?? 'the share helper refused the call'))
}

/** A call got no sign of life in its time: the share is not answering. */
function noAnswer(h, c) {
  if (!h.calls.has(c.n) || h.stuck) return
  const child = h.child
  h.stuck = { since: c.lastAt, op: c.op, child }
  h.child = null
  for (const x of [...h.calls.values()]) {
    settle(h, x)
    x.reject(fail('ESHARESTUCK', 'share not answering'))
  }
  try {
    child?.kill('SIGKILL')
  } catch {}
  console.warn(`[storage] ${h.root}: no answer to a ${LABEL[c.op] ?? c.op} in ${Math.round((Date.now() - c.lastAt) / 1000)} s: share not answering; its helper (pid ${child?.pid}) stopped`)
  for (const cb of stuckListeners) {
    try {
      cb({ id: h.id, path: h.root }, c.op)
    } catch (e) {
      console.warn(`[storage] share-stuck listener failed: ${e.message}`)
    }
  }
}

function ended(h, child, code, signal, err) {
  if (h.stuck?.child === child) {
    const s = Math.round((Date.now() - h.stuck.since) / 1000)
    h.stuck = null
    console.log(`[storage] ${h.root}: the stuck share helper (pid ${child.pid}) has exited, ${s} s after its last answer; the next call starts a new one`)
    return
  }
  if (child !== h.child) return
  h.child = null
  const why = err ? `could not be started: ${err.message}` : `stopped (${signal ? `signal ${signal}` : `exit code ${code}`})`
  if (h.calls.size) console.warn(`[storage] ${h.root}: its share helper (pid ${child.pid}) ${why}; ${h.calls.size} call${h.calls.size === 1 ? '' : 's'} failed`)
  for (const x of [...h.calls.values()]) {
    settle(h, x)
    x.reject(fail('ESHAREGONE', `the share helper ${why}`))
  }
}

/**
 * Asks the helper of `loc` ({ id, path }) to make a file call (share-ops.mjs: probe, statfs, stat,
 * readdir, unlink, rmdir, thin, thinSwap, thinCommit, thinAbort, thinRecover). Never waits on the share:
 * it fails with .code 'ESHARESTUCK' ("share not answering") when a file call does not come back within
 * timeoutMs, or at once while the location's last helper is still stuck; 'ESHAREGONE' when the helper
 * ended by itself; else the helper's own code when it refused (EOUTSIDE, EMARKER, EBADOP, ...).
 * @returns {Promise<any>}
 */
export function shareCall(loc, op, args = {}, { timeoutMs = answerMs } = {}) {
  if (typeof loc?.id !== 'string' || typeof loc?.path !== 'string' || !isAbsolute(loc.path)) return Promise.reject(new TypeError('a location needs an id and a full path'))
  const h = helperFor(loc)
  if (h.stuck) return Promise.reject(fail('ESHARESTUCK', `share not answering: a ${LABEL[h.stuck.op] ?? h.stuck.op} has been stuck for ${Math.round((Date.now() - h.stuck.since) / 1000)} s`))
  if (!h.child) {
    try {
      start(h)
    } catch (e) {
      h.child = null
      return Promise.reject(fail('ESHAREGONE', `the share helper could not be started: ${e.message}`))
    }
  }
  return new Promise((resolveCall, rejectCall) => {
    const c = { n: ++seq, op, timeoutMs, lastAt: Date.now(), timer: null, resolve: resolveCall, reject: rejectCall }
    c.timer = setTimeout(() => noAnswer(h, c), timeoutMs)
    h.calls.set(c.n, c)
    const child = h.child
    const lost = (e) => {
      if (!h.calls.has(c.n) || h.child !== child) return
      settle(h, c)
      rejectCall(fail('ESHAREGONE', `the share helper could not be reached: ${e.message}`))
    }
    try {
      child.send({ n: c.n, op, args }, (e) => e && lost(e))
    } catch (e) {
      lost(e)
    }
  })
}

/** cb({ id, path }, op) when a call on a location got no answer (the share is stuck). */
export function onShareStuck(cb) {
  stuckListeners.add(cb)
  return () => stuckListeners.delete(cb)
}

/** { since, op } while the location's helper is stuck and has not exited yet, else null. */
export function shareStuckFor(loc) {
  const s = helpers.get(keyOf(loc))?.stuck
  return s ? { since: s.since, op: s.op } : null
}

function stop(h, why) {
  const child = h.child
  h.child = null
  for (const x of [...h.calls.values()]) {
    settle(h, x)
    x.reject(fail('ESHAREGONE', `the share helper was stopped: ${why}`))
  }
  try {
    child?.disconnect?.() // it exits when its channel closes
  } catch {}
  try {
    child?.kill('SIGKILL') // and if it is stuck, it goes as soon as it can
  } catch {}
  try {
    h.stuck?.child?.kill('SIGKILL')
  } catch {}
  helpers.delete(h.key)
}

/** Stops the helpers of locations not in `locs` (removed from the list, or their folder changed). */
export function keepShareHelpers(locs) {
  const keep = new Set(locs.filter((l) => typeof l?.id === 'string' && typeof l?.path === 'string').map(keyOf))
  for (const h of [...helpers.values()]) if (!keep.has(h.key)) stop(h, 'the location is no longer in the list')
}

/** Stops every helper (tests; the server's own helpers end with it). */
export function stopShareHelpers() {
  for (const h of [...helpers.values()]) stop(h, 'stopped')
}

export const _test = {
  setHelper(p) {
    HELPER = p ?? join(import.meta.dirname, 'share-helper.mjs')
  },
  setFork(fn) {
    forkFn = fn ?? fork
  },
  setAnswerMs(ms) {
    answerMs = ms
  },
  forks: () => forks,
  pidOf: (loc) => helpers.get(keyOf(loc))?.child?.pid ?? null
}
