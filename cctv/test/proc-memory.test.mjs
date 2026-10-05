// Tests for proc-memory.mjs: each process's memory in the workers' 5 s STATS and one line per
// process an hour in the main log (perf report Task 0, 2026-09-29: the workers' growth figures were
// too thin to judge). No SDK, Windows-safe (the /proc figures are null there).
//   node cctv/test/proc-memory.test.mjs
const { MEMORY_EVERY_MS, memoryLine, memoryNow, parseStatus, startMemoryLog } = await import('../proc-memory.mjs')

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
const MB = 1024 * 1024

// ---- /proc/self/status -------------------------------------------------------------------------------
const STATUS = `Name:\tnode
Umask:\t0022
State:\tS (sleeping)
Pid:\t5678
VmPeak:\t 1812344 kB
VmSize:\t 1745032 kB
VmHWM:\t  522240 kB
VmRSS:\t  505856 kB
RssAnon:\t  460800 kB
RssFile:\t   44032 kB
RssShmem:\t    1024 kB
VmData:\t  901232 kB
Threads:\t45
`
{
  const s = parseStatus(STATUS)
  check('VmRSS in bytes', s.vmRss === 505856 * 1024, String(s.vmRss))
  check('...its parts: anonymous (the program), files, shared', s.rssAnon === 460800 * 1024 && s.rssFile === 44032 * 1024 && s.rssShmem === 1024 * 1024)
  check('...the peak (VmHWM) and the threads', s.vmHwm === 522240 * 1024 && s.threads === 45)
  const none = parseStatus('')
  check('nothing to read (not Linux): every figure null', Object.values(none).every((v) => v === null), JSON.stringify(none))
  check('a field missing is null, the rest still read', parseStatus('VmRSS:\t 100 kB\n').vmRss === 102400 && parseStatus('VmRSS:\t 100 kB\n').rssAnon === null)
}

// ---- this process ---------------------------------------------------------------------------------
{
  const m = memoryNow()
  check('memoryNow(): pid and process.memoryUsage() figures', m.pid === process.pid && [m.rss, m.heapTotal, m.heapUsed, m.external, m.arrayBuffers].every((v) => Number.isFinite(v) && v >= 0) && m.rss > 0 && m.heapUsed > 0, JSON.stringify(m))
  if (process.platform === 'linux') check('memoryNow(): VmRSS and its parts from /proc/self/status (Linux)', m.vmRss > 0 && m.rssAnon > 0 && m.vmHwm >= m.vmRss && m.threads > 0, JSON.stringify(m))
  else check('memoryNow(): no /proc here, so VmRSS is null, not made up', m.vmRss === null && m.rssAnon === null, JSON.stringify(m))
  check('memoryNow(): plain data (it crosses the worker pipe)', JSON.stringify(structuredClone(m)) === JSON.stringify(m))
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 100; i++) memoryNow()
  const us = Number(process.hrtime.bigint() - t0) / 1000 / 100
  check('memoryNow(): cheap enough for every 5 s (under 1 ms)', us < 1000, `${us.toFixed(0)} µs`)
}

// ---- the line ----------------------------------------------------------------------------------------
const linux = { pid: 5678, rss: 505856 * 1024, heapTotal: 150 * MB, heapUsed: 120 * MB, external: 30 * MB, arrayBuffers: 12 * MB, ...parseStatus(STATUS) }
{
  const l = memoryLine('worker nvr1', linux)
  check('a line: VmRSS with its parts and peak, the JS heap, external, threads', l === '[memory] worker nvr1 (pid 5678): VmRSS 494 MB (anon 450, file 43, shmem 1; peak 510), JS heap 120 of 150 MB, external 30 MB (array buffers 12 MB), 45 threads', l)
  const later = { ...linux, vmRss: linux.vmRss + 55 * MB }
  const l2 = memoryLine('worker nvr1', later, { pid: 5678, vmRss: linux.vmRss, rss: linux.rss, at: 0 }, 60 * 60_000)
  check('...and how far VmRSS moved since the last line of the same process', l2.endsWith('; VmRSS +55 MB in 60 min'), l2)
  const l3 = memoryLine('worker nvr1', { ...linux, vmRss: linux.vmRss - 3 * MB }, { pid: 5678, vmRss: linux.vmRss, at: 0 }, 60 * 60_000)
  check('...down too', l3.endsWith('; VmRSS -3 MB in 60 min'), l3)
  const l4 = memoryLine('worker nvr1', { ...linux, pid: 9999 }, { pid: 5678, vmRss: linux.vmRss, at: 0 }, 60 * 60_000)
  check('a new process since the last line: said, no difference made up', l4.includes('(pid 9999)') && l4.endsWith('; a new process since the last line (pid 5678 then)'), l4)
  const win = { pid: 1, rss: 80 * MB, heapTotal: 20 * MB, heapUsed: 10 * MB, external: 2 * MB, arrayBuffers: MB, ...parseStatus('') }
  const lw = memoryLine('main', win, { pid: 1, rss: 70 * MB, vmRss: null, at: 0 }, 30 * 60_000)
  check('no /proc: rss from process.memoryUsage() instead', lw === '[memory] main (pid 1): rss 80 MB, JS heap 10 of 20 MB, external 2 MB (array buffers 1 MB); rss +10 MB in 30 min', lw)
  check('no figures at all (a worker restarting): said so', memoryLine('worker nvr-2', null) === '[memory] worker nvr-2: no figures just now (not running, or restarting)')
}

// ---- once an hour, one line per process ----------------------------------------------------------------
{
  check('every hour', MEMORY_EVERY_MS === 60 * 60_000)
  let now = 0
  let w1 = { ...linux }
  let w2 = null
  const lines = []
  const log = startMemoryLog({ sources: () => [{ name: 'main', mem: { ...linux, pid: 1 } }, { name: 'worker nvr1', mem: w1 }, { name: 'worker nvr-2', mem: w2 }], clock: () => now, log: (l) => lines.push(l), timers: false })
  log.tick()
  check('one line per process', lines.length === 3 && lines[0].startsWith('[memory] main (pid 1)') && lines[1].startsWith('[memory] worker nvr1 (pid 5678)') && lines[2] === '[memory] worker nvr-2: no figures just now (not running, or restarting)', lines.join(' | '))
  now = 60 * 60_000
  w1 = { ...linux, vmRss: linux.vmRss + 20 * MB }
  w2 = { ...linux, pid: 4444 }
  lines.length = 0
  log.tick()
  check('an hour later: the growth of each process that was there before', lines[1].endsWith('; VmRSS +20 MB in 60 min') && lines[0].endsWith('; VmRSS +0 MB in 60 min'), lines.join(' | '))
  check('...and a worker that came back is a first line again', lines[2].startsWith('[memory] worker nvr-2 (pid 4444)') && !lines[2].includes(' in 60 min'), lines[2])
  let threw = 0
  const bad = startMemoryLog({ sources: () => { threw++; throw new Error('boom') }, clock: () => 0, log: () => {}, warn: (l) => lines.push(l), timers: false })
  lines.length = 0
  bad.tick()
  check('a source that throws: one warning line, and the log goes on', threw === 1 && lines.length === 1 && /^\[memory\] could not be read: boom/.test(lines[0]), lines.join(' | '))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
