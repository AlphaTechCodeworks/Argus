// A camera's microphone, for the one person listening to it (Live, the speaker button on a camera
// shown full size). The NVR sends a camera's sound with its picture (SDK frame type 2: on the fleet,
// G.711 A-law, 8 kHz, mono, 320 bytes every 40 ms); live.mjs used to drop it. Sound never travels
// with the video frames: those go to the recorder, the converters and every viewer, none of which
// expect it. It has its own small path instead, and only while somebody is listening:
//
//   browser /audio socket -> listen() here -> "audiowant" to the NVR's worker (worker-ipc.mjs)
//   worker: live.mjs hands it each sound frame of that camera -> "audio" message -> onFrame() here
//   -> every socket listening to that camera
//
// Nothing is asked of the NVR for this: sound is taken from whichever of the camera's streams is
// already playing for the listener's picture. Sound is never recorded or kept.
//
// Pure (no SDK, no server): tested in test/audio-hub.test.mjs.

/** WAVEFORMATEX tags the browser can play (public/live-audio.js). */
export const FORMATS = { 6: 'alaw', 7: 'ulaw' }
/** The first 8 bytes of a WAVEFORMATEX: tag, channels, sample rate. null for anything unreadable. */
export function parseWaveFormat(buf) {
  if (!buf || buf.length < 8) return null
  const tag = buf.readUInt16LE(0)
  const channels = buf.readUInt16LE(2)
  const rate = buf.readUInt32LE(4)
  if (!channels || channels > 2 || rate < 4000 || rate > 96000) return null
  return { tag, channels, rate }
}

const MAX_LISTENERS_EACH = 8 // one camera's sound to at most this many sockets
const MAX_BUFFERED = 64 * 1024 // a listener this far behind (8 s of sound) is skipped until it catches up

export function makeAudioHub() {
  const workers = new Map() // nvr id -> send(message) => boolean
  const cameras = new Map() // "nvr/ch" -> { listeners: Set<ws>, format: object|null }
  const keyOf = (nvr, ch) => `${nvr}/${ch}`
  const tell = (nvr, ch, on) => {
    try {
      workers.get(nvr)?.({ t: 'audiowant', ch, on })
    } catch {} // a worker that is going: it is told again when it is ready (workerReady)
  }
  const hello = (ws, format) => {
    const name = format ? FORMATS[format.tag] : null
    try {
      ws.send(JSON.stringify(name ? { format: name, rate: format.rate, channels: format.channels } : { format: null, why: format ? 'This camera\'s sound is in a format the browser cannot play.' : 'waiting' }))
    } catch {}
  }
  return {
    /** The way to an NVR's worker (worker-supervisor.mjs); null when it has none. */
    setWorker(nvr, send) {
      if (send) workers.set(nvr, send)
      else workers.delete(nvr)
    },
    /** A worker has (re)started: it is told again which cameras are being listened to. */
    workerReady(nvr) {
      for (const [key, cam] of cameras) {
        const [id, ch] = [key.slice(0, key.lastIndexOf('/')), Number(key.slice(key.lastIndexOf('/') + 1))]
        if (id === nvr && cam.listeners.size) tell(nvr, ch, true)
      }
    },
    /**
     * A socket starts listening to a camera. @returns {(() => void)|null} stop; null when the camera
     * already has as many listeners as it may.
     */
    listen(nvr, ch, ws) {
      const key = keyOf(nvr, ch)
      let cam = cameras.get(key)
      if (!cam) cameras.set(key, (cam = { listeners: new Set(), format: null }))
      if (cam.listeners.size >= MAX_LISTENERS_EACH) return null
      cam.listeners.add(ws)
      if (cam.listeners.size === 1) tell(nvr, ch, true)
      else if (cam.format) hello(ws, cam.format)
      return () => {
        if (!cam.listeners.delete(ws)) return
        if (cam.listeners.size === 0) {
          cameras.delete(key)
          tell(nvr, ch, false)
        }
      }
    },
    /** A sound frame from an NVR's worker: { ch, buf, tag, channels, rate }. */
    onFrame(nvr, m) {
      const cam = cameras.get(keyOf(nvr, m?.ch))
      if (!cam || !m.buf?.length) return
      if (!cam.format || cam.format.tag !== m.tag || cam.format.rate !== m.rate || cam.format.channels !== m.channels) {
        cam.format = { tag: m.tag, channels: m.channels, rate: m.rate }
        for (const ws of cam.listeners) hello(ws, cam.format)
      }
      if (!FORMATS[cam.format.tag]) return
      for (const ws of cam.listeners) {
        if (ws.readyState !== 1 || ws.bufferedAmount > MAX_BUFFERED) continue
        try {
          ws.send(m.buf)
        } catch {}
      }
    },
    /** How many cameras are being listened to, and by how many sockets (Health, tests). */
    stats() {
      let listeners = 0
      for (const cam of cameras.values()) listeners += cam.listeners.size
      return { cameras: cameras.size, listeners }
    }
  }
}

/** The one hub of this process (server.mjs, worker-supervisor.mjs). */
export const audioHub = makeAudioHub()
