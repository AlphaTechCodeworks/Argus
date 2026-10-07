export const HEALTH_WARN_MS = 5000
export const HEALTH_RECOVER_MS = 12000

export function offlineHealth(camera) {
  if (camera.nvrOnline === false) return 'NVR offline'
  if (camera.cameraOnline === false) return 'Camera offline'
  if (camera.nvrVideoOnline === false) return 'Video connection reconnecting'
  return 'Offline'
}

/** Packet arrival is not proof that a decoder is displaying pictures. */
export function streamHealth({ now, openedAt, dataAt, frameAt, waiting = false, hidden = false }) {
  const baseline = frameAt || openedAt
  const age = Math.max(0, now - baseline)
  if (hidden) return { stale: false, recover: false, text: '' }
  if (waiting) return { stale: true, recover: false, text: 'Waiting for NVR stream' }
  if (age < HEALTH_WARN_MS) return { stale: false, recover: false, text: '' }
  const recentData = dataAt > 0 && now - dataAt < HEALTH_WARN_MS
  return {
    stale: true,
    recover: age >= HEALTH_RECOVER_MS,
    text: recentData ? 'Video stalled' : frameAt ? 'Connection slow - waiting for video' : 'No video received'
  }
}

export function healthyRetryReset(firstFrameAt, now) {
  return firstFrameAt > 0 && now - firstFrameAt >= 10000
}
