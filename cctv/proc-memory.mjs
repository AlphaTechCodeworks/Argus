// Each process's memory: in every NVR worker's 5 s STATS (nvr-worker.mjs) and one line per process
// an hour in the main log (server.mjs). The performance audit of 2026-09-29 saw the workers grow
// (nvr1 439 -> 494 MB in 58 min, but +3.6 MB in the last 27; nvr-2 284 -> 337 MB before an abort)
// from a few hand-taken samples, too thin to say whether it levels off, and whether it is JavaScript
// (heap, buffers) or native (the SDK, malloc arenas: MALLOC_ARENA_MAX would only help that). So
// (Task 0): process.memoryUsage() for the JavaScript side, and /proc/self/status for VmRSS split
// into anonymous memory (the program's own), file pages and shared memory, its peak and the threads.
//
//   memoryNow()                            -> plain data, sent over the worker pipe every 5 s
//   startMemoryLog({ sources })            -> "[memory] worker nvr1 (pid 5678): VmRSS 494 MB (...)"
import { readFileSync } from 'node:fs'

export const MEMORY_EVERY_MS = 60 * 60_000
// the first lines this long after the start: a baseline from which the first hour's growth shows,
// rather than an hour-old process as the first figure (the workers are up and recording by then)
const FIRST_MS = 10 * 60_000
const MB = 1024 * 1024

const FIELDS = { VmRSS: 'vmRss', VmHWM: 'vmHwm', RssAnon: 'rssAnon', RssFile: 'rssFile', RssShmem: 'rssShmem' }

/** The memory lines of a /proc/<pid>/status text, in bytes, and the threads; null for any not there. */
export function parseStatus(text) {
  const out = { vmRss: null, vmHwm: null, rssAnon: null, rssFile: null, rssShmem: null, threads: null }
  for (const line of String(text).split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)(?:\s+kB)?\s*$/)
    if (!m) continue
    if (m[1] in FIELDS) out[FIELDS[m[1]]] = Number(m[2]) * 1024
    else if (m[1] === 'Threads') out.threads = Number(m[2])
  }
  return out
}

/** This process's memory now, as plain data (it crosses the worker pipe). A read of /proc, no share. */
export function memoryNow() {
  const u = process.memoryUsage()
  let status = ''
  if (process.platform === 'linux') {
    try {
      status = readFileSync('/proc/self/status', 'utf8')
    } catch {} // (nothing to add, the rest still stands)
  }
  return { pid: process.pid, rss: u.rss, heapTotal: u.heapTotal, heapUsed: u.heapUsed, external: u.external, arrayBuffers: u.arrayBuffers, ...parseStatus(status) }
}

const mb = (b) => Math.round(b / MB)

/**
 * One process's line. `prev` is what the last line of the same name said ({ pid, vmRss, rss, at }),
 * `at` when this one is written: the change since is added when it is the same process.
 */
export function memoryLine(name, m, prev = null, at = Date.now()) {
  if (!m || !Number.isFinite(m.rss)) return `[memory] ${name}: no figures just now (not running, or restarting)`
  const proc = Number.isFinite(m.vmRss)
  const parts = [m.rssAnon, m.rssFile, m.rssShmem].every(Number.isFinite) ? ` (anon ${mb(m.rssAnon)}, file ${mb(m.rssFile)}, shmem ${mb(m.rssShmem)}${Number.isFinite(m.vmHwm) ? `; peak ${mb(m.vmHwm)}` : ''})` : ''
  const size = proc ? `VmRSS ${mb(m.vmRss)} MB${parts}` : `rss ${mb(m.rss)} MB`
  const threads = Number.isFinite(m.threads) ? `, ${m.threads} threads` : ''
  let line = `[memory] ${name} (pid ${m.pid}): ${size}, JS heap ${mb(m.heapUsed)} of ${mb(m.heapTotal)} MB, external ${mb(m.external)} MB (array buffers ${mb(m.arrayBuffers)} MB)${threads}`
  if (prev && prev.pid !== m.pid) line += `; a new process since the last line (pid ${prev.pid} then)`
  else if (prev) {
    const was = proc ? prev.vmRss : prev.rss
    const now = proc ? m.vmRss : m.rss
    if (Number.isFinite(was)) {
      const d = mb(now - was)
      line += `; ${proc ? 'VmRSS' : 'rss'} ${d < 0 ? '-' : '+'}${Math.abs(d)} MB in ${Math.round((at - prev.at) / 60_000)} min`
    }
  }
  return line
}

/**
 * One line per process, FIRST_MS after the start and then every hour.
 * @param {{ sources: () => { name: string, mem: object|null }[], everyMs?: number, firstMs?: number,
 *           clock?: () => number, log?: (l: string) => void, warn?: (l: string) => void, timers?: boolean }} o
 *   sources: this process and each worker (its last STATS `mem`, null while it restarts)
 *   timers:  false for the tests, which call tick() themselves
 */
export function startMemoryLog({ sources, everyMs = MEMORY_EVERY_MS, firstMs = FIRST_MS, clock = Date.now, log = console.log, warn = console.warn, timers = true }) {
  const last = new Map() // name -> { pid, vmRss, rss, at }
  const tick = () => {
    try {
      const at = clock()
      for (const { name, mem } of sources()) {
        log(memoryLine(name, mem, last.get(name) ?? null, at))
        if (mem && Number.isFinite(mem.rss)) last.set(name, { pid: mem.pid, vmRss: mem.vmRss, rss: mem.rss, at })
      }
    } catch (e) {
      warn(`[memory] could not be read: ${e.message}`)
    }
  }
  let first = null
  let every = null
  if (timers) {
    first = setTimeout(() => {
      tick()
      every = setInterval(tick, everyMs)
      every.unref()
    }, firstMs)
    first.unref()
  }
  return {
    tick,
    stop() {
      clearTimeout(first)
      clearInterval(every)
    }
  }
}
