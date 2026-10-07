export class ReceiveMetrics {
  constructor(now = performance.now()) { this.reset(now) }
  reset(now) {
    this.at = now
    this.bytes = 0
    this.frames = 0
    this.samples = []
  }
  receive(bytes) { this.bytes += bytes; this.frames++ }
  sample(now) {
    const elapsed = now - this.at
    if (elapsed <= 0) return { receivedFps: 0, receivedKbps: 0 }
    this.samples.push({ elapsed, bytes: this.bytes })
    while (this.samples.length > 1 && this.samples.reduce((n, s) => n + s.elapsed, 0) - this.samples[0].elapsed >= 5000) this.samples.shift()
    const duration = this.samples.reduce((n, s) => n + s.elapsed, 0)
    const bytes = this.samples.reduce((n, s) => n + s.bytes, 0)
    const result = { receivedFps: Math.round(this.frames * 10000 / elapsed) / 10, receivedKbps: Math.round(bytes * 8 / duration) }
    this.at = now
    this.bytes = 0
    this.frames = 0
    return result
  }
}

export function liveMetricsText(stats, main, active) {
  const resolution = active && stats.width > 0 && stats.height > 0 ? `${stats.width}\u00d7${stats.height}` : '--'
  const codec = active ? (/^(hvc1|hev1)/i.test(stats.codec) ? 'H.265' : /^avc[13]/i.test(stats.codec) ? 'H.264' : '--') : '--'
  const fps = active && Number.isFinite(stats.receivedFps) ? `${stats.receivedFps} FPS` : '-- FPS'
  const rate = active && Number.isFinite(stats.receivedKbps) ? `${(stats.receivedKbps / 1000).toFixed(2)} Mbps` : '-- Mbps'
  return `${main ? 'Main' : 'Sub'} \u00b7 ${resolution} \u00b7 ${codec} \u00b7 ${fps} \u00b7 ${rate}`
}
