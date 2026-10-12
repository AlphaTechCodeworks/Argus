// A camera's microphone, played while the speaker button of the full-size view is on. The server
// sends the camera's sound on its own socket (/audio, cctv/audio-hub.mjs): first a line of JSON saying
// what it is ({ format: 'alaw'|'ulaw', rate, channels }), then the sound itself, a few hundred bytes
// every 40 ms. G.711 is one byte a sample: it is expanded with a table and handed to the browser's
// audio output a little behind real time (LEAD_S), so a late packet is not a click.
//
// decode() and the tables are pure and tested without a browser (test/live-audio.test.mjs).

/** One G.711 A-law byte as a 16-bit sample. */
export function alawSample(a) {
  a ^= 0x55
  let t = (a & 0x0f) << 4
  const seg = (a & 0x70) >> 4
  if (seg === 0) t += 8
  else if (seg === 1) t += 0x108
  else t = (t + 0x108) << (seg - 1)
  return a & 0x80 ? t : -t
}

/** One G.711 mu-law byte as a 16-bit sample. */
export function ulawSample(u) {
  u = ~u & 0xff
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4)
  return u & 0x80 ? 0x84 - t : t - 0x84
}

const TABLES = {
  alaw: Float32Array.from({ length: 256 }, (_, i) => alawSample(i) / 32768),
  ulaw: Float32Array.from({ length: 256 }, (_, i) => ulawSample(i) / 32768)
}

/**
 * A packet of G.711 as samples at `outRate`, stretched in a straight line between the camera's
 * samples (8 kHz sound has nothing above 4 kHz to lose): browsers differ on the lowest rate they
 * will play, and all of them play their own. Stereo is taken as its left channel.
 * @param {Uint8Array} bytes @param {'alaw'|'ulaw'} format
 * @param {{ rate: number, channels?: number, outRate: number, last?: number }} o last: the sample
 *   the packet before ended on, so two packets join without a step
 * @returns {{ samples: Float32Array, last: number }|null} null for a format that is not played
 */
export function decode(bytes, format, { rate, channels = 1, outRate, last = 0 }) {
  const table = TABLES[format]
  if (!table || !(rate > 0) || !(outRate > 0)) return null
  const n = Math.floor(bytes.length / channels)
  const out = new Float32Array(Math.round((n * outRate) / rate))
  const step = rate / outRate
  for (let i = 0; i < out.length; i++) {
    const pos = i * step
    const k = Math.floor(pos)
    const a = k === 0 ? (pos < 1 ? table[bytes[0]] : last) : table[bytes[k * channels]]
    const b = k + 1 < n ? table[bytes[(k + 1) * channels]] : a
    out[i] = a + (b - a) * (pos - k)
  }
  return { samples: out, last: n ? table[bytes[(n - 1) * channels]] : last }
}

const LEAD_S = 0.15 // sound is played this far behind its arrival
const MAX_AHEAD_S = 0.8 // further ahead than this (a burst after a stall): it is dropped to catch up

/**
 * Plays one camera's sound until stop(). Must be made from a click (browsers only start sound then).
 * @param {{ nvr: string, ch: number }} cam
 * @param {(state: 'connecting'|'playing'|'silent'|'unsupported'|'closed', why?: string) => void} onState
 * @returns {{ stop: () => void }}
 */
export function listenTo(cam, onState = () => {}) {
  const Ctx = window.AudioContext ?? window.webkitAudioContext
  if (!Ctx) {
    onState('unsupported', 'This browser cannot play sound here.')
    return { stop() {} }
  }
  const ctx = new Ctx()
  ctx.resume?.().catch(() => {})
  let format = null
  let next = 0
  let last = 0
  let stopped = false
  let heard = false
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/audio?nvr=${encodeURIComponent(cam.nvr)}&ch=${cam.ch}`)
  ws.binaryType = 'arraybuffer'
  onState('connecting')
  // no sound within a few seconds: the camera has no microphone switched on, or is not playing
  const quiet = setTimeout(() => { if (!heard && !stopped) onState('silent', 'No sound is coming from this camera.') }, 6000)
  ws.onmessage = (e) => {
    if (stopped) return
    if (typeof e.data === 'string') {
      let m = null
      try { m = JSON.parse(e.data) } catch {}
      if (m?.format) format = m
      else if (m && m.why && m.why !== 'waiting') onState('unsupported', m.why)
      return
    }
    if (!format) return
    const d = decode(new Uint8Array(e.data), format.format, { rate: format.rate, channels: format.channels, outRate: ctx.sampleRate, last })
    if (!d || d.samples.length === 0) return
    last = d.last
    const now = ctx.currentTime
    if (next < now + 0.02) next = now + LEAD_S // the first packet, or the output ran dry
    if (next > now + MAX_AHEAD_S) return
    const buffer = ctx.createBuffer(1, d.samples.length, ctx.sampleRate)
    buffer.getChannelData(0).set(d.samples)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    src.start(next)
    next += buffer.duration
    if (!heard) {
      heard = true
      onState('playing')
    }
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    clearTimeout(quiet)
    try { ws.close() } catch {}
    ctx.close?.().catch(() => {})
    onState('closed')
  }
  ws.onclose = (e) => {
    if (stopped) return
    const why = e.code === 1008 ? 'You may not listen to this camera.' : e.code === 1013 ? 'Too many people are listening to this camera.' : 'The sound stopped.'
    stop()
    onState('closed', why)
  }
  return { stop }
}
