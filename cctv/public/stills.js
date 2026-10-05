// The last picture seen of each camera, kept on this device, so a tile shows something the moment
// it appears instead of black while its stream starts.
//
// About once a minute while a camera plays, a small JPEG of it (at most 480 px wide, ~15 KB) is
// kept in this browser's Cache Storage under /still/<nvr>/<ch>. A new tile paints it at once,
// dimmed, and drops it at the first live frame. Nothing is asked of the server or the NVR, and the
// live picture is untouched. Everything here fails quietly: no store just means no still.
//
// One save at a time, at least SPACING_MS apart, the cameras in the order they became due. A save is
// a canvas copy and a JPEG encode on the page's main thread, and a grid's tiles start 15 ms apart, so
// every one of them was due in the same second of each minute: on the owner's PC one such round of
// 27 tiles took 156-559 ms of the main thread, which plays every tile's video too (stutter report
// 2.10, 29 Sep). Spread out, 27 tiles take about a minute of 2 s turns; a bigger grid's cameras keep
// a still less often than once a minute, never at once.
const STORE = 'argus-stills'
const EVERY_MS = 60_000
const SPACING_MS = 2000
// a save whose JPEG never came back (toBlob's callback) holds the next no longer than this
const BUSY_MAX_MS = 10_000
// a camera waiting its turn that has not asked again for this long (its tile closed, or was hidden)
// loses its place; every playing camera sends a frame at least every keyframe interval, 2-4 s here
const FORGET_MS = 5000
const MAX_W = 480
const lastSaved = new Map() // key -> ms
const waiting = new Map() // key -> when it last asked: cameras due, in the order they became due
let saving = null // the save under way: { at } (null: none)
let lastStart = -Infinity
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

/**
 * Keeps a still of what `canvas` shows now, at most once a minute per camera, when it is this camera's
 * turn (see SPACING_MS). Called on every frame: a camera whose turn has not come is asked again with the
 * next one, and what is kept is the picture of that moment.
 */
export function maybeKeepStill(canvas, nvr, ch, now = Date.now()) {
  const key = keyOf(nvr, ch)
  if (now - (lastSaved.get(key) ?? 0) < EVERY_MS) return
  if (typeof caches === 'undefined' || !canvas.width || !canvas.height) return
  // due: in the queue behind the cameras due before it (a Map keeps a key where it was first set)
  waiting.set(key, now)
  if ((saving && now - saving.at < BUSY_MAX_MS) || now - lastStart < SPACING_MS) return
  for (const [k, askedAt] of waiting) {
    if (k === key) break
    if (now - askedAt <= FORGET_MS) return // one due before it is still playing: its turn first
    waiting.delete(k)
  }
  waiting.delete(key)
  lastSaved.set(key, now)
  lastStart = now
  const save = { at: now }
  saving = save
  const done = () => {
    if (saving === save) saving = null
  }
  try {
    const scale = Math.min(1, MAX_W / canvas.width)
    const c = document.createElement('canvas')
    c.width = Math.round(canvas.width * scale)
    c.height = Math.round(canvas.height * scale)
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height)
    c.toBlob(async (blob) => {
      try {
        if (blob) await (await caches.open(STORE)).put(key, new Response(blob, { headers: { 'content-type': 'image/jpeg' } }))
      } catch {}
      done()
    }, 'image/jpeg', 0.7)
  } catch {
    done()
  }
}
