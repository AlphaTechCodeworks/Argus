// Tests for sysinfo.mjs: the /proc parsing and the rate arithmetic, with fixture text rather
// than a real /proc, so this runs on Windows as well as on the server.
// Run: node cctv/test/sysinfo.test.mjs
import { makeSysinfo, parseStat, parseMeminfo, parseNetDev, parseDiskstats, parseLoadavg, readGpu } from '../sysinfo.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

// ---- fixtures: real text from a four-core Linux recorder ---------------------------------------
const STAT = (idle = 900_000, user = 120_000) => `cpu  ${user} 500 40000 ${idle} 3000 0 700 0 0 0
cpu0 30000 120 10000 ${Math.round(idle / 4)} 800 0 200 0 0 0
cpu1 30000 130 10000 ${Math.round(idle / 4)} 700 0 180 0 0 0
cpu2 30000 130 10000 ${Math.round(idle / 4)} 750 0 170 0 0 0
cpu3 30000 120 10000 ${Math.round(idle / 4)} 750 0 150 0 0 0
intr 123456789 0 0
ctxt 987654321
btime 1758700000
processes 44412
procs_running 2
procs_blocked 0
`

const MEMINFO = `MemTotal:       16316004 kB
MemFree:          542188 kB
MemAvailable:   11342112 kB
Buffers:          182364 kB
Cached:          9421008 kB
SwapCached:            0 kB
Active:          3821044 kB
Inactive:        8934112 kB
`

const NETDEV = (rx = 1_000_000_000, tx = 50_000_000) => `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9876543   12345    0    0    0     0          0         0  9876543   12345    0    0    0     0       0          0
  eth0: ${rx}  4210099    0    0    0     0          0     10021  ${tx}  1002331    0    0    0     0       0          0
  eth1:     4096      12    0    0    0     0          0         0     2048       8    0    0    0     0       0          0
`

const DISKSTATS = (written = 2_000_000) => ` 259       0 nvme0n1 120334 4120 9876543 44120 ${written} 88231 ${written * 2} 331002 0 88112 402000 0 0 0 0
 259       1 nvme0n1p1 3021 120 44100 812 ${Math.round(written / 2)} 1220 ${written} 4120 0 3112 5000 0 0 0 0
   8       0 sda 44120 1120 882100 12000 100000 4120 400000 21000 0 18000 33000 0 0 0 0
   8       1 sda1 4120 120 82100 1200 50000 412 200000 2100 0 1800 3300 0 0 0 0
   7       0 loop0 12 0 96 4 0 0 0 0 0 4 4 0 0 0 0
`

// ---- parsing -----------------------------------------------------------------------------------
{
  const s = parseStat(STAT())
  check('cpu totals sum every jiffy column', s.total === 120000 + 500 + 40000 + 900000 + 3000 + 0 + 700, String(s.total))
  check('iowait counts as idle, not busy', s.idle === 900000 + 3000, String(s.idle))
  check('cores are counted from the per-cpu lines', s.cores === 4, String(s.cores))
}
{
  const m = parseMeminfo(MEMINFO)
  check('memory total is read in bytes', m.total === 16316004 * 1024, String(m.total))
  check('available is MemAvailable, not MemFree', m.available === 11342112 * 1024, String(m.available))
  check('used is total minus available', m.used === (16316004 - 11342112) * 1024, String(m.used))
}
{
  const n = parseNetDev(NETDEV())
  check('loopback is excluded from the network totals', n.rx === 1_000_000_000 + 4096, String(n.rx))
  check('transmit is the ninth column', n.tx === 50_000_000 + 2048, String(n.tx))
}
{
  const d = parseDiskstats(DISKSTATS())
  // whole disks only: nvme0n1 and sda, in 512-byte sectors, loop0 and the partitions dropped
  check('disk writes count whole disks only, as bytes', d === (4_000_000 + 400_000) * 512, String(d))
}
{
  check('the 1-minute load average is the first field', parseLoadavg('1.42 0.98 0.71 2/512 44120\n') === 1.42)
}

// ---- unreadable files ---------------------------------------------------------------------------
{
  const s = makeSysinfo({ read: () => { throw new Error('ENOENT') }, now: () => 0 })
  let r
  check('an unreadable /proc does not throw', (() => { try { r = s.sample(); return true } catch { return false } })())
  check('and every figure is null', r.cpu.percent === null && r.memory.total === null && r.network.rxBytesPerSec === null && r.disk.writeBytesPerSec === null, JSON.stringify(r))
}
{
  check('garbage text parses to nulls rather than NaN', parseMeminfo('not a meminfo').total === null)
  check('an empty diskstats is null', parseDiskstats('') === null)
  check('a net/dev with only loopback is null', parseNetDev(NETDEV().split('\n').slice(0, 3).join('\n')).rx === null)
}

// ---- rates -------------------------------------------------------------------------------------
const reader = (state) => (path) => {
  if (path.endsWith('/stat')) return STAT(state.idle, state.user)
  if (path.endsWith('/meminfo')) return MEMINFO
  if (path.endsWith('/net/dev')) return NETDEV(state.rx, state.tx)
  if (path.endsWith('/diskstats')) return DISKSTATS(state.written)
  if (path.endsWith('/loadavg')) return '1.42 0.98 0.71 2/512 44120\n'
  throw new Error('ENOENT')
}
{
  const state = { idle: 900_000, user: 120_000, rx: 1_000_000_000, tx: 50_000_000, written: 2_000_000 }
  let t = 1000
  const s = makeSysinfo({ read: reader(state), now: () => t, gpu: null })

  const first = s.sample()
  check('the first sample has no cpu percentage', first.cpu.percent === null)
  check('the first sample has no network rate', first.network.rxBytesPerSec === null && first.network.txBytesPerSec === null)
  check('the first sample has no disk rate', first.disk.writeBytesPerSec === null)
  check('but the gauges are there at once', first.memory.total > 0 && first.cpu.cores === 4 && first.cpu.load1 === 1.42)

  // 10 s later: 1000 more jiffies, 400 of them idle -> 60 % busy; 100 MB in, 10 MB out.
  t += 10_000
  state.idle += 400
  state.user += 600 // 1000 more jiffies in all, 400 of them idle
  state.rx += 100_000_000
  state.tx += 10_000_000
  state.written += 100_000 // sectors on nvme0n1; sda unchanged
  const second = s.sample()
  check('the second sample gives a cpu percentage', second.cpu.percent === 60, String(second.cpu.percent))
  check('receive is bytes per second', second.network.rxBytesPerSec === 10_000_000, String(second.network.rxBytesPerSec))
  check('transmit is bytes per second', second.network.txBytesPerSec === 1_000_000, String(second.network.txBytesPerSec))
  check('disk write is bytes per second', second.disk.writeBytesPerSec === (200_000 * 512) / 10, String(second.disk.writeBytesPerSec))
}

// ---- wraparound and a clock that goes backwards --------------------------------------------------
{
  const state = { idle: 900_000, rx: 4_000_000_000, tx: 50_000_000, written: 2_000_000 }
  let t = 1000
  const s = makeSysinfo({ read: reader(state), now: () => t, gpu: null })
  s.sample()
  t += 10_000
  state.rx = 1_000_000 // the 32-bit counter wrapped
  const r = s.sample()
  check('a wrapped counter gives null, not a negative rate', r.network.rxBytesPerSec === null, String(r.network.rxBytesPerSec))
  check('and not an absurd one either', !(r.network.rxBytesPerSec > 0))
}
{
  const state = { idle: 900_000, rx: 1_000_000_000, tx: 50_000_000, written: 2_000_000 }
  let t = 100_000
  const s = makeSysinfo({ read: reader(state), now: () => t, gpu: null })
  s.sample()
  t -= 5000 // NTP stepped the clock back
  state.rx += 1_000_000
  const r = s.sample()
  check('a backwards clock gives null rates', r.network.rxBytesPerSec === null && r.cpu.percent === null, JSON.stringify(r.network))
}

// ---- GPU ----------------------------------------------------------------------------------------
{
  const g = readGpu({ runNvidiaSmi: () => '37, 1024, 8192\n', readDrm: () => null })
  check('nvidia-smi output is read as percent and bytes', g.percent === 37 && g.memUsed === 1024 * 1024 * 1024 && g.memTotal === 8192 * 1024 * 1024, JSON.stringify(g))
}
{
  const g = readGpu({ runNvidiaSmi: () => { throw new Error('ENOENT') }, readDrm: () => 12 })
  check('an integrated card falls back to gpu_busy_percent', g.percent === 12 && g.name === 'Integrated', JSON.stringify(g))
}
{
  const g = readGpu({ runNvidiaSmi: () => { throw new Error('ENOENT') }, readDrm: () => null })
  check('no GPU at all is null, never a fake zero', g === null, JSON.stringify(g))
}
{
  const state = { idle: 900_000, rx: 1, tx: 1, written: 1 }
  let calls = 0
  const s = makeSysinfo({ read: reader(state), now: () => 1000, gpu: { runNvidiaSmi: () => { calls++; throw new Error('ENOENT') }, readDrm: () => null } })
  s.sample()
  s.sample()
  check('a missing GPU is only probed once', calls === 1, String(calls))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
