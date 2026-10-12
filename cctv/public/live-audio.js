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

/**
 * The background filter's gate: how much of a packet is let through, from how loud it is against
 * the quietest the camera has lately been (its hum and hiss). Speech and bangs stand well above
 * that floor and pass whole; what sits on the floor is turned down to FLOOR_GAIN, never to nothing
 * (silence that cuts in and out is worse to listen to than a little hiss).
 * @param {number} rms the packet's level @param {number} floor the noise floor
 * @returns {number} FLOOR_GAIN..1
 */
export const FLOOR_GAIN = 0.12
export function gateGain(rms, floor) {
  if (!(floor > 0)) return 1
  const over = rms / floor
  if (over >= 3) return 1
  if (over <= 1.4) return FLOOR_GAIN
  return FLOOR_GAIN + ((over - 1.4) / 1.6) * (1 - FLOOR_GAIN)
}

/** The level of a packet of samples (root mean square). */
export function levelOf(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return samples.length ? Math.sqrt(sum / samples.length) : 0
}

/**
 * The noise floor as packets come: it falls at once to a quieter packet and creeps up slowly
 * otherwise (about 1.5 % a packet, 25 packets a second), so talk does not raise it but a fan that
 * starts is learnt in a few seconds.
 */
export const nextFloor = (floor, rms) => (floor === null ? rms : rms < floor ? rms : floor * 1.015 + 1e-6)

const LEAD_S = 0.15 // sound is played this far behind its arrival
const MAX_AHEAD_S = 0.8 // further ahead than this (a burst after a stall): it is dropped to catch up

/**
 * Plays one camera's sound until stop(). Must be made from a click (browsers only start sound then).
 * @param {{ nvr: string, ch: number }} cam
 * @param {(state: 'connecting'|'playing'|'silent'|'unsupported'|'closed', why?: string) => void} onState
 * @param {{ volume?: number, filter?: boolean }} [o] volume 0..2 (1 is as the camera sends it); filter:
 *   the background filter (below)
 * @returns {{ stop: () => void, setVolume: (v: number) => void, setFilter: (on: boolean) => void }}
 */
export function listenTo(cam, onState = () => {}, { volume = 1, filter = false } = {}) {
  const Ctx = window.AudioContext ?? window.webkitAudioContext
  if (!Ctx) {
    onState('unsupported', 'This browser cannot play sound here.')
    return { stop() {}, setVolume() {}, setFilter() {} }
  }
  const ctx = new Ctx()
  ctx.resume?.().catch(() => {})
  // every packet goes through: a filter that keeps the band a voice is in (hum and rumble below it,
  // hiss above it), then the volume. With the background filter off the band is wide open.
  const high = ctx.createBiquadFilter()
  high.type = 'highpass'
  const low = ctx.createBiquadFilter()
  low.type = 'lowpass'
  const gain = ctx.createGain()
  high.connect(low)
  low.connect(gain)
  gain.connect(ctx.destination)
  let filtering = false
  let floor = null // the background's level, learnt while the filter is on
  let gate = 1
  const setVolume = (v) => { gain.gain.value = Math.min(2, Math.max(0, Number(v) || 0)) }
  const setFilter = (on) => {
    filtering = on === true
    high.frequency.value = filtering ? 250 : 20
    low.frequency.value = filtering ? 3400 : 20000
    if (!filtering) { floor = null; gate = 1 }
  }
  setVolume(volume)
  setFilter(filter)
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
    if (filtering) {
      // the gate: quiet packets (the background alone) are turned down, moving a little at a time
      const rms = levelOf(d.samples)
      floor = nextFloor(floor, rms)
      const want = gateGain(rms, floor)
      gate += (want - gate) * (want > gate ? 0.6 : 0.2) // opens fast, closes gently
      if (gate < 0.999) for (let i = 0; i < d.samples.length; i++) d.samples[i] *= gate
    }
    const buffer = ctx.createBuffer(1, d.samples.length, ctx.sampleRate)
    buffer.getChannelData(0).set(d.samples)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(high)
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
  return { stop, setVolume, setFilter }
}
