// What the server sends out, split by where it goes, and what its video conversions cost: for the
// Health page's "Remote viewing" section.
//
//   internet: viewers through Tailscale (the public link and tailnet devices; adaptive-live.mjs
//             isRemoteAddress), which is what uses the site's uplink
//   local:    viewers on the site's own network
// Counted at the video sockets (live, playback, motion), which is nearly all of it; page loads and
// API calls are small next to video and are not counted.
import { readFileSync, readdirSync } from 'node:fs'
import { isRemoteAddress } from './adaptive-live.mjs'

const RATE_WINDOW_MS = 5000
const make = () => ({ bytes: 0, sockets: 0, bps: 0 })
const counters = { internet: make(), local: make() }
let windowStart = Date.now()
let windowBytes = { internet: 0, local: 0 }

function roll(now = Date.now()) {
  const dt = now - windowStart
  if (dt < RATE_WINDOW_MS) return
  for (const k of ['internet', 'local']) {
    counters[k].bps = Math.round((windowBytes[k] * 1000) / dt)
    windowBytes[k] = 0
  }
  windowStart = now
}

/** Counts everything sent on this socket, under internet or local by where the viewer is. */
export function meterSocket(ws, remoteAddress) {
  const k = isRemoteAddress(remoteAddress) ? 'internet' : 'local'
  counters[k].sockets++
  const send = ws.send.bind(ws)
  ws.send = (data, ...rest) => {
    const n = data?.length ?? data?.byteLength ?? 0
    counters[k].bytes += n
    windowBytes[k] += n
    return send(data, ...rest)
  }
  ws.on?.('close', () => counters[k].sockets--)
  return k
}

// ---- the conversions' CPU, from /proc (Linux) ----------------------------------------------------
let lastCpu = null // { at, ticks }
const CLK_TCK = 100

/** Percent of one core the running ffmpeg processes used since the last call; null off Linux. */
export function ffmpegCpuPercent(now = Date.now()) {
  let ticks = 0
  let count = 0
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue
      try {
        if (readFileSync(`/proc/${pid}/comm`, 'utf8').trim() !== 'ffmpeg') continue
        const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
        ticks += Number(f[11]) + Number(f[12]) // utime + stime
        count++
      } catch {} // it exited while being read
    }
  } catch {
    return { percent: null, processes: 0 }
  }
  const prev = lastCpu
  lastCpu = { at: now, ticks }
  // a process that ended since last time takes its ticks with it: never report a negative figure
  const pct = prev && now > prev.at ? Math.max(0, ((ticks - prev.ticks) / CLK_TCK) / ((now - prev.at) / 1000) * 100) : null
  return { percent: pct === null ? null : Math.round(pct), processes: count }
}

/** The figures for /api/health. */
export function trafficSummary() {
  roll()
  return {
    internet: { ...counters.internet },
    local: { ...counters.local }
  }
}
