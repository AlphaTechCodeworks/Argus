import * as fsp from 'node:fs/promises'

// One read at a time, bounded pending work, deduplicated across playback sessions.
export function createReadAhead({ fs = fsp, maxPending = 32, maxDone = 500, chunkBytes = 1024 * 1024 } = {}) {
  const pending = new Set(), done = new Set()
  const buffer = Buffer.allocUnsafe(chunkBytes)
  let busy = false
  async function drain() {
    if (busy) return
    busy = true
    try {
      while (pending.size) {
        const path = pending.values().next().value
        let fh
        try {
          fh = await fs.open(path, 'r')
          for (;;) {
            const { bytesRead } = await fh.read(buffer, 0, buffer.length, null)
            if (bytesRead < buffer.length) break
          }
          done.add(path)
          if (done.size > maxDone) done.delete(done.values().next().value)
        } catch { /* Failed reads remain retryable on the next request. */ }
        finally { await fh?.close().catch(() => {}); pending.delete(path) }
      }
    } finally { busy = false }
  }
  return function readAhead(path) {
    if (!path || done.has(path) || pending.has(path) || pending.size >= maxPending) return
    pending.add(path)
    void drain()
  }
}
