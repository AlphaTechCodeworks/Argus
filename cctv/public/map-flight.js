// View-only flight planning. Saved camera coordinates never enter this module.
export function planFlight(from, to, { width, height, minZoom = 0, duration } = {}) {
  const distance = Math.hypot(to.cx - from.cx, to.cy - from.cy) * 2 ** from.zoom
  const span = Math.max(width || 1, height || 1)
  const pullback = Math.min(Math.max(0, Math.log2(Math.max(distance / span, 1))), 4)
  const lowest = Math.max(minZoom, Math.min(from.zoom, to.zoom) - pullback)
  const ms = duration ?? Math.min(1400, Math.max(350, 450 + 220 * Math.log2(1 + distance / span) + 80 * Math.abs(to.zoom - from.zoom)))
  return { lowest, pullback, duration: distance < 0.5 && Math.abs(to.zoom - from.zoom) < 0.001 ? 0 : ms }
}

export function flightPose(from, to, lowest, pullback, progress) {
  const t = Math.min(1, Math.max(0, progress))
  // Zero velocity and acceleration at both ends avoid a visible start/landing jerk.
  const eased = t * t * t * (t * (t * 6 - 15) + 10)
  const straight = from.zoom + (to.zoom - from.zoom) * eased
  const hump = pullback > 0.15 ? Math.sin(Math.PI * eased) ** 2 : 0
  return {
    cx: from.cx + (to.cx - from.cx) * eased,
    cy: from.cy + (to.cy - from.cy) * eased,
    zoom: straight - (straight - lowest) * hump
  }
}
