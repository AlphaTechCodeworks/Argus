// Live machine figures for the Health page: CPU, memory, network, disk write rate and (if there
// is one) a GPU. Everything comes from /proc and /sys, so there is no npm dependency and nothing
// to shell out to except the optional nvidia-smi.
//
// Why a sampler object rather than a function: CPU, network and disk are counters, not gauges.
// A single read of /proc/stat cannot tell you a percentage, only the total jiffies since boot, so
// the previous reading has to be kept and the difference divided by the elapsed time. That is why
// every rate is null on the first sample: reporting 0 would be a lie, and on a server pulling a
// dozen camera streams a fake "0 Mbps" is exactly the figure someone would act on.
//
// Nothing here ever throws. It runs on every health poll (every 30 s), so an unreadable file must
// give null for that one figure and leave the rest alone.
//
// Disk: the recording locations carry only a folder path (see server.mjs locationState), not a
// device, and mapping a path to its block device means reading /proc/self/mountinfo and walking
// device-mapper/RAID layers. That is not "simple", so this totals writes across the real block
// devices instead, skipping loop/ram/zram/dm and partitions of a disk already counted. On these
// boxes the only sustained writer is the recorder, so the total is the recording write rate.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const SECTOR = 512 // /proc/diskstats counts 512-byte sectors whatever the drive's real sector size

/** Default reader: throws when the file is missing, which every caller below turns into null. */
const defaultRead = (path) => readFileSync(path, 'utf8')

/** A rate that survives a counter reset: a fall means the counter wrapped or the device went away. */
function rate(prev, now, dtSec) {
  if (prev === null || now === null || dtSec === null) return null
  if (now < prev) return null // wraparound or a reset counter: one unknown sample beats a huge lie
  return (now - prev) / dtSec
}

/** cpu busy/total jiffies from /proc/stat, plus the core count, or nulls. */
export function parseStat(text) {
  const out = { total: null, idle: null, cores: null }
  try {
    let cores = 0
    for (const line of String(text).split('\n')) {
      if (/^cpu\d+\s/.test(line)) cores++
      if (!/^cpu\s/.test(line)) continue
      const n = line.trim().split(/\s+/).slice(1).map(Number)
      if (n.some((v) => !Number.isFinite(v))) continue
      // idle + iowait both count as not-busy: a server waiting on a disk is not using its CPU.
      out.idle = (n[3] ?? 0) + (n[4] ?? 0)
      out.total = n.reduce((a, b) => a + b, 0)
    }
    out.cores = cores || null
  } catch {
    /* leave the nulls */
  }
  return out
}

/** Bytes from /proc/meminfo. `available` is the honest "how much can a program still have". */
export function parseMeminfo(text) {
  const kb = (key) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(String(text))
    return m ? Number(m[1]) * 1024 : null
  }
  try {
    const total = kb('MemTotal')
    const available = kb('MemAvailable')
    return { total, available, used: total !== null && available !== null ? total - available : null }
  } catch {
    return { total: null, available: null, used: null }
  }
}

/** Total rx/tx bytes across every interface except loopback. */
export function parseNetDev(text) {
  try {
    let rx = 0
    let tx = 0
    let seen = false
    for (const line of String(text).split('\n')) {
      const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line)
      if (!m) continue
      const iface = m[1]
      if (iface === 'lo' || iface.startsWith('lo:')) continue
      const n = m[2].trim().split(/\s+/).map(Number)
      if (n.length < 9 || !Number.isFinite(n[0]) || !Number.isFinite(n[8])) continue
      rx += n[0]
      tx += n[8]
      seen = true
    }
    return seen ? { rx, tx } : { rx: null, tx: null }
  } catch {
    return { rx: null, tx: null }
  }
}

/** Sectors written across real block devices, as bytes. Skips virtual devices and partitions. */
export function parseDiskstats(text) {
  try {
    const rows = []
    for (const line of String(text).split('\n')) {
      const f = line.trim().split(/\s+/)
      if (f.length < 10) continue
      const name = f[2]
      const sectors = Number(f[9])
      if (!name || !Number.isFinite(sectors)) continue
      if (/^(loop|ram|zram|dm-|sr|fd|md)/.test(name)) continue
      rows.push({ name, sectors })
    }
    if (!rows.length) return null
    const names = new Set(rows.map((r) => r.name))
    // A partition (sda1, nvme0n1p2) repeats its disk's writes, so it is dropped when the whole
    // disk is also listed; a bare partition with no parent (a passed-through volume) is kept.
    const isPartition = (n) =>
      names.has(n.replace(/p?\d+$/, '')) && n.replace(/p?\d+$/, '') !== n
    return rows.filter((r) => !isPartition(r.name)).reduce((a, r) => a + r.sectors * SECTOR, 0)
  } catch {
    return null
  }
}

/** 1-minute load average, or null. */
export function parseLoadavg(text) {
  const m = /^\s*([\d.]+)/.exec(String(text))
  const v = m ? Number(m[1]) : NaN
  return Number.isFinite(v) ? v : null
}

/**
 * GPU, best effort. Most of these installs have no GPU worth reporting (the app does no
 * transcoding), so null is the normal answer and the page must say "none detected" for it.
 * @returns {{ percent: number|null, memUsed: number|null, memTotal: number|null, name: string }|null}
 */
export function readGpu({ runNvidiaSmi = defaultNvidiaSmi, readDrm = defaultDrm } = {}) {
  try {
    const out = runNvidiaSmi()
    if (out) {
      const [util, used, total] = String(out).split('\n')[0].split(',').map((s) => Number(s.trim()))
      if (Number.isFinite(util)) {
        return {
          percent: util,
          memUsed: Number.isFinite(used) ? used * 1024 * 1024 : null,
          memTotal: Number.isFinite(total) ? total * 1024 * 1024 : null,
          name: 'NVIDIA'
        }
      }
    }
  } catch {
    /* no nvidia-smi, or it failed: fall through to the integrated card */
  }
  try {
    const busy = readDrm()
    if (busy !== null && Number.isFinite(busy)) return { percent: busy, memUsed: null, memTotal: null, name: 'Integrated' }
  } catch {
    /* no /sys/class/drm/card*/
  }
  return null
}

function defaultNvidiaSmi() {
  // execFileSync throws ENOENT when the binary is absent, which is the common case.
  return execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], {
    encoding: 'utf8',
    timeout: 2000
  })
}

/** Intel and AMD expose a single busy percentage; the first card that has one wins. */
function defaultDrm() {
  const base = '/sys/class/drm'
  if (!existsSync(base)) return null
  for (const entry of readdirSync(base)) {
    if (!/^card\d+$/.test(entry)) continue
    const f = `${base}/${entry}/device/gpu_busy_percent`
    if (!existsSync(f)) continue
    const v = Number(String(readFileSync(f, 'utf8')).trim())
    if (Number.isFinite(v)) return v
  }
  return null
}

/**
 * @param {object} [opts]
 * @param {(path: string) => string} [opts.read] reads one file; tests point it at fixtures
 * @param {string} [opts.procDir] default '/proc'
 * @param {() => number} [opts.now] ms clock
 * @param {object} [opts.gpu] { runNvidiaSmi, readDrm } for readGpu, or null to skip the GPU
 * @returns {{ sample: () => object }}
 */
export function makeSysinfo({ read = defaultRead, procDir = '/proc', now = Date.now, gpu = {} } = {}) {
  let prev = null // { t, cpu:{total,idle}, net:{rx,tx}, diskWritten }
  // Spawning nvidia-smi every 30 s on a box that has no GPU is pure waste, so the first miss is
  // remembered: a GPU is not hot-plugged into a running recorder.
  let noGpu = gpu === null

  const readOr = (name) => {
    try {
      return read(`${procDir}/${name}`)
    } catch {
      return null // an unreadable file is one null figure, never a thrown health poll
    }
  }

  function sample() {
    const t = now()
    const statText = readOr('stat')
    const memText = readOr('meminfo')
    const netText = readOr('net/dev')
    const diskText = readOr('diskstats')
    const loadText = readOr('loadavg')

    const cpuNow = statText === null ? { total: null, idle: null, cores: null } : parseStat(statText)
    const mem = memText === null ? { total: null, available: null, used: null } : parseMeminfo(memText)
    const netNow = netText === null ? { rx: null, tx: null } : parseNetDev(netText)
    const diskNow = diskText === null ? null : parseDiskstats(diskText)
    const load1 = loadText === null ? null : parseLoadavg(loadText)

    // A clock that has gone backwards (NTP stepping the box, which happens on these NVR hosts)
    // would otherwise turn every rate negative or enormous.
    const dtSec = prev && t > prev.t ? (t - prev.t) / 1000 : null

    let cpuPercent = null
    if (prev && dtSec !== null && cpuNow.total !== null && prev.cpu.total !== null) {
      const dTotal = cpuNow.total - prev.cpu.total
      const dIdle = cpuNow.idle - prev.cpu.idle
      if (dTotal > 0 && dIdle >= 0 && dIdle <= dTotal) cpuPercent = Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10
    }

    const out = {
      cpu: { percent: cpuPercent, cores: cpuNow.cores, load1 },
      memory: { total: mem.total, used: mem.used, available: mem.available },
      network: {
        rxBytesPerSec: prev ? rate(prev.net.rx, netNow.rx, dtSec) : null,
        txBytesPerSec: prev ? rate(prev.net.tx, netNow.tx, dtSec) : null
      },
      disk: { writeBytesPerSec: prev ? rate(prev.diskWritten, diskNow, dtSec) : null },
      gpu: noGpu ? null : readGpu(gpu)
    }

    if (out.gpu === null) noGpu = true

    prev = { t, cpu: { total: cpuNow.total, idle: cpuNow.idle }, net: netNow, diskWritten: diskNow }
    return out
  }

  return { sample }
}
