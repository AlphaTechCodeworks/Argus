// Session-only previews: camera images never survive account navigation.
const previews = new Map()
const EVERY_MS = 60000, MAX_AGE_MS = 900000, MAX_BYTES = 1048576, MAX_ENTRIES = 64
let nextSave = 0, saving = null, generation = 0
const keyOf = (nvr, ch) => `${nvr}/${ch}`
export async function purgeCameraStills() {
  generation++; previews.clear()
  if (typeof caches === 'undefined') return
  try { for (const name of await caches.keys()) if (name.startsWith('argus-stills')) await caches.delete(name) } catch {}
}
void purgeCameraStills()
export async function showStill(tile, nvr, ch) {
  const entry = previews.get(keyOf(nvr, ch))
  if (!entry || Date.now() - entry.at > MAX_AGE_MS || !tile.isConnected || tile.dataset.live === '1') return
  disposeStill(tile)
  const url = URL.createObjectURL(entry.blob)
  tile.dataset.stillUrl = url; tile.classList.add('has-still'); tile.style.backgroundImage = `url("${url}")`
}
export function disposeStill(tile) {
  if (tile.dataset.stillUrl) URL.revokeObjectURL(tile.dataset.stillUrl)
  delete tile.dataset.stillUrl; tile.style.backgroundImage = ''; tile.classList.remove('has-still')
}
export function clearStill(tile) { tile.dataset.live = '1'; disposeStill(tile) }
export function maybeKeepStill(canvas, nvr, ch, now = Date.now()) {
  const key = keyOf(nvr, ch)
  if ((saving && now - saving.at < 10000) || now < nextSave || now - (previews.get(key)?.at ?? 0) < EVERY_MS || !canvas.width || !canvas.height) return
  const save = { at: now }
  saving = save; nextSave = now + 2000
  const epoch = generation
  const done = () => { if (saving === save) saving = null }
  const timeout = setTimeout(done, 10000)
  try {
    const scale = Math.min(1, 320 / canvas.width), copy = document.createElement('canvas')
    copy.width = Math.max(1, Math.round(canvas.width * scale)); copy.height = Math.max(1, Math.round(canvas.height * scale))
    copy.getContext('2d').drawImage(canvas, 0, 0, copy.width, copy.height)
    copy.toBlob(blob => {
      clearTimeout(timeout); done()
      if (!blob || blob.size > MAX_BYTES || epoch !== generation) return
      previews.delete(key); previews.set(key, { blob, at: now })
      let bytes = [...previews.values()].reduce((n, p) => n + p.blob.size, 0)
      for (const [old, entry] of previews) {
        if (previews.size <= MAX_ENTRIES && bytes <= MAX_BYTES && now - entry.at <= MAX_AGE_MS) break
        previews.delete(old); bytes -= entry.blob.size
      }
    }, 'image/jpeg', 0.65)
  } catch { clearTimeout(timeout); done() }
}
