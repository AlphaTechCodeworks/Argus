// The motion tuning view's arithmetic, with no DOM in it: how much of the picture changed between
// two sampled frames, what that reads as on a meter, and how the NVR's zone grid maps onto the
// picture. motion-tune.js paints; this decides. Tested in cctv/test/events.test.mjs.
//
// One thing this file is careful never to do: pretend our measurement and the NVR's sensitivity
// number are the same scale. They are not, and nobody has told us what the NVR's scale means. Ours
// is "this percentage of the watched pixels changed between two samples"; the NVR's is a number
// between its own min and max. The view shows both and says plainly that one is not the other,
// because a slider that claims to predict what the NVR will do would be a guess dressed up as a
// measurement.

/** A pixel must change by this many grey levels to count, the same threshold motion.mjs uses. */
export const PIXEL_DELTA = 22

/**
 * The fraction of pixels that changed between two greyscale samples, with an overall lighting
 * change subtracted out — so a cloud crossing the sun, or headlights sweeping a wall, counts for
 * far less than something actually moving.
 *
 * `mask`, when given, is one byte per pixel: 0 for a pixel the NVR is not watching. Pixels outside
 * the watched zones are left out of both the count and the total, so the figure means "of the part
 * being watched", which is the only figure worth comparing with a threshold.
 *
 * @returns {number} 0..1, or null when there is nothing to compare
 */
export function changedFraction(a, b, mask = null) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return null
  let sum = 0
  let counted = 0
  for (let i = 0; i < a.length; i++) {
    if (mask && !mask[i]) continue
    sum += b[i] - a[i]
    counted++
  }
  if (!counted) return null
  const shift = sum / counted
  let n = 0
  for (let i = 0; i < a.length; i++) {
    if (mask && !mask[i]) continue
    if (Math.abs(b[i] - a[i] - shift) > PIXEL_DELTA) n++
  }
  return n / counted
}

/**
 * The meter reading: the newest measurement, a short rolling average so the needle does not jitter,
 * and the peak seen in this session. All three are shown, because a threshold is chosen against
 * what the quiet moments look like as much as against the busy ones.
 */
export function meterReading(history, { windowN = 10 } = {}) {
  const vals = (history ?? []).filter((v) => Number.isFinite(v))
  if (!vals.length) return { now: null, average: null, peak: null, samples: 0 }
  const recent = vals.slice(-windowN)
  return {
    now: vals.at(-1),
    average: recent.reduce((t, v) => t + v, 0) / recent.length,
    peak: Math.max(...vals),
    samples: vals.length
  }
}

/** A fraction as a percentage for the page. Null stays null: never a reassuring 0 %. */
export const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)} %` : '—');

/**
 * A mask over a `w` x `h` sample, from the NVR's zone grid (motion-tune.mjs readArea).
 * With no grid — an NVR that does not report its zones — the whole picture is watched, and the view
 * says so, rather than drawing a grid that was never read from anything.
 * @returns {{ mask: Uint8Array|null, why: string }}
 */
export function maskFromArea(area, w, h) {
  if (!area?.cells?.length) return { mask: null, why: 'this NVR does not tell us which parts of the picture it watches, so the whole picture is measured' }
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = area.cells[Math.min(area.rows - 1, Math.floor((y / h) * area.rows))]
    for (let x = 0; x < w; x++) {
      mask[y * w + x] = row[Math.min(area.cols - 1, Math.floor((x / w) * area.cols))] ? 1 : 0
    }
  }
  const watched = mask.reduce((t, v) => t + v, 0)
  if (!watched) return { mask: null, why: 'the NVR reports that no part of this picture is watched for motion' }
  return { mask, why: '' }
}

/**
 * What to say about a sensitivity number. The scale is the NVR's, and we have not been told what it
 * means, so this states the number and its range and stops there.
 */
export function thresholdNote(motion) {
  if (!motion?.available) return motion?.why ?? 'not available'
  const range = motion.min !== null && motion.max !== null ? ` (this NVR's range is ${motion.min}–${motion.max})` : ' (this NVR does not say what its range is)'
  return `The NVR's motion sensitivity for this camera is ${motion.sensitivity}${range}. The meter above is this server measuring the picture; it is not the same scale as that number, and neither figure predicts the other.`
}

/** The confirmation sentence somebody has to agree to before a threshold is written. */
export const confirmText = (cameraName, was, want) =>
  `Change the motion sensitivity on the NVR for ${cameraName} from ${was} to ${want}? This changes a setting on the owner's NVR and affects what it records from now on.`
