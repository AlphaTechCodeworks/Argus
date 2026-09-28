// The last picture seen of each camera, kept on this device, so a tile shows something the moment
// it appears instead of black while its stream starts.
//
// About once a minute while a camera plays, a small JPEG of it (at most 480 px wide, ~15 KB) is
// kept in this browser's Cache Storage under /still/<nvr>/<ch>. A new tile paints it at once,
// dimmed, and drops it at the first live frame. Nothing is asked of the server or the NVR, and the
// live picture is untouched. Everything here fails quietly: no store just means no still.
const STORE = 'argus-stills'
const EVERY_MS = 60_000
const MAX_W = 480
const lastSaved = new Map() // key -> ms
const keyOf = (nvr, ch) => `/still/${encodeURIComponent(nvr)}/${ch}`

/** Paints the kept still behind `tile` (until clearStill). */
export async function showStill(tile, nvr, ch) {
  try {
    if (typeof caches === 'undefined') return
    const res = await (await caches.open(STORE)).match(keyOf(nvr, ch))
    if (!res || !tile.isConnected || tile.dataset.live === '1') return
    const blob = await res.blob()
    // the first live frame may have come while the still was read: clearStill has run already, and a
    // still shown now would stay, hiding the live canvas under it
    if (!tile.isConnected || tile.dataset.live === '1') return
    const url = URL.createObjectURL(blob)
    tile.dataset.stillUrl = url
    tile.classList.add('has-still')
    tile.style.backgroundImage = `url("${url}")`
  } catch {}
}

/** The live picture has arrived: the still goes. */
export function clearStill(tile) {
  tile.dataset.live = '1'
  if (!tile.classList.contains('has-still')) return
  tile.classList.remove('has-still')
  tile.style.backgroundImage = ''
  const url = tile.dataset.stillUrl
  if (url) URL.revokeObjectURL(url)
  delete tile.dataset.stillUrl
}

/** Keeps a still of what `canvas` shows now, at most once a minute per camera. */
export function maybeKeepStill(canvas, nvr, ch, now = Date.now()) {
  const key = keyOf(nvr, ch)
  if (now - (lastSaved.get(key) ?? 0) < EVERY_MS) return
  if (typeof caches === 'undefined' || !canvas.width || !canvas.height) return
  lastSaved.set(key, now)
  try {
    const scale = Math.min(1, MAX_W / canvas.width)
    const c = document.createElement('canvas')
    c.width = Math.round(canvas.width * scale)
    c.height = Math.round(canvas.height * scale)
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height)
    c.toBlob(async (blob) => {
      if (!blob) return
      try {
        await (await caches.open(STORE)).put(key, new Response(blob, { headers: { 'content-type': 'image/jpeg' } }))
      } catch {}
    }, 'image/jpeg', 0.7)
  } catch {}
}
