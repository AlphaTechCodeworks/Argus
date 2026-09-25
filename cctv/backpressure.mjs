// Backpressure for live video sockets (live.mjs LiveStream, stream-hub.mjs HubStream) and for the
// worker's tap to the main process (nvr-worker.mjs).
//
// A socket whose send queue passes its cap gets nothing at all, keyframes included, until the
// queue has drained below RESUME_BELOW; it then resumes on the next keyframe (its decoder cannot
// use deltas that follow frames it never got). A socket that stays over its cap for STUCK_MS has
// a peer that stopped reading (a frozen tab): it is terminated (close() would wait for a close
// handshake stuck behind the backlog) and the browser reconnects by itself (live-tile.js).
// Taps pass stuckMs 0: they are never closed.
export const CAP_BYTES = { 0: 4 * 1024 * 1024, 1: 1024 * 1024 } // by stream type: 0 = main, 1 = sub
export const RESUME_BELOW = 256 * 1024
export const STUCK_MS = 30_000
export const PING_MS = 15_000

/**
 * Whether to send this frame to ws now; updates ws.waitForKey / ws.overSince and terminates a
 * socket stuck over its cap.
 * @param {{ readyState: number, OPEN: number, bufferedAmount: number, waitForKey?: boolean, overSince?: number|null,
 *           terminate?: () => void, close?: (code?: number, reason?: string) => void }} ws
 * @param {boolean} isKey
 * @param {{ cap: number, resume?: number, stuckMs?: number, now?: number }} opts
 */
export function gateSend(ws, isKey, { cap, resume = RESUME_BELOW, stuckMs = STUCK_MS, now = Date.now() }) {
  if (ws.readyState !== ws.OPEN) return false
  const queued = ws.bufferedAmount
  if (queued > cap) {
    ws.waitForKey = true
    ws.overSince ??= now
    if (stuckMs > 0 && now - ws.overSince > stuckMs) {
      ws.overSince = null
      if (typeof ws.terminate === 'function') ws.terminate()
      else ws.close?.(1008, 'not reading')
    }
    return false
  }
  ws.overSince = null
  if (ws.waitForKey) {
    if (!isKey || queued > resume) return false
    ws.waitForKey = false
  }
  return true
}

/**
 * Pings every socket of wss every intervalMs; a socket that did not answer the previous ping
 * (dead peer, cable pulled: TCP alone never notices) is terminated.
 * @returns {{ stop: () => void }}
 */
export function keepAlive(wss, { intervalMs = PING_MS, setInterval: every = setInterval } = {}) {
  wss.on('connection', (ws) => {
    ws.isAlive = true
    ws.on('pong', () => (ws.isAlive = true))
  })
  const timer = every(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate()
        continue
      }
      ws.isAlive = false
      try {
        ws.ping()
      } catch {}
    }
  }, intervalMs)
  timer?.unref?.()
  return { stop: () => clearInterval(timer) }
}
