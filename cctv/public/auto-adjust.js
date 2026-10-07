// Auto adjust, the rules (plan v2, §4.5-§4.6): what one measurement of the live picture
// (picture-check.js) and of the main stream (stream-check.js) suggests for one camera's own
// settings, and how sure each suggestion is.
//
// Nothing here talks to a camera. A suggestion is only a prefilled value in the Picture panel
// (image-panel.js); it reaches the camera when an admin presses Apply there.
//
// Evidence and limits: every threshold comes from dusk and night clips of these cameras (plan
// §4.4), so most suggestions are "optional" (shown unticked). Only returns to the camera's own
// factory values that the data clearly supports are ticked: hue, saturation above the default,
// and hand-set sharpening on a stream pressed against its bitrate cap. Anything that can
// restart the camera, pause recording, switch the floodlight or turn the picture over "needs
// your confirmation" (the server asks for it again, tied to the exact change).
//
// Pure: no DOM, node-testable (test/auto-adjust.test.mjs).
import { COLOUR, NOISE_BANDS, castName, noiseBand } from './picture-check.js'

/** Georgetown area: where the sun is when a camera has no place on the site map. */
export const SITE = { lat: 6.8, lng: -58.16 }
/** Sun elevation (degrees): day at or above +6, night below -6, dusk between. */
export const PERIOD = { DAY: 6, NIGHT: -6 }
/** Stream grades (plan §4.5): usage = measured kbit/s over the cap. */
export const STREAM = { BINDING: 0.9, BIND_SHARE: 0.8, NEAR: 0.75, HEADROOM: 0.5, IGNORES: 1.2 }
/** Exposure thresholds on coded values (the lowest dusk clip had a mean of 86.2). */
export const EXPOSURE = { DARK: 85, BRIGHT: 165, FLAT: 136, GLARE: 0.005, DIM_IR: 60 }
export const FOCUS = { SOFT: 2.5, MIN_WIDTH: 1920, LIT_MEAN: 90 }
/** A change helps only when it moves its figure by more than twice the figure's own A/B spread (and 5%). */
export const CONVERGE = { ROUNDS: 3, SPREADS: 2, RELATIVE: 0.05, NO_SPREAD: 0.15 }

const r3 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000)
const same = (a, b) => String(a) === String(b)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const pct = (v) => `${Math.round((v / 255) * 100)}%`
const pc1 = (v) => `${(v * 100).toFixed(1)}%`
const PROFILE_NAMES = { normal: 'Normal', day: 'Day', night: 'Night' }
const profileName = (p) => PROFILE_NAMES[p] ?? p

// ---- light: where the sun is --------------------------------------------------------------

const rad = (d) => (d * Math.PI) / 180
const deg = (r) => (r * 180) / Math.PI

/**
 * The sun's elevation in degrees at a time (ms or Date) and place, with atmospheric
 * refraction: the NOAA solar calculator's formulas (good to a fraction of a degree, plenty
 * for a +-6 degree line).
 */
export function solarElevation(when, lat, lng) {
  const t = when instanceof Date ? when.getTime() : Number(when)
  const jc = (t / 86400000 + 2440587.5 - 2451545) / 36525 // Julian centuries since J2000
  const L0 = (((280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360) + 360) % 360
  const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc)
  const C = Math.sin(rad(M)) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * jc) + Math.sin(rad(3 * M)) * 0.000289
  const omega = 125.04 - 1934.136 * jc
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(rad(omega))
  const eps0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60
  const eps = eps0 + 0.00256 * Math.cos(rad(omega))
  const decl = Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda)))
  const y = Math.tan(rad(eps / 2)) ** 2
  const eqTime = 4 * deg(y * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(rad(M)) + 4 * e * y * Math.sin(rad(M)) * Math.cos(2 * rad(L0)) - 0.5 * y * y * Math.sin(4 * rad(L0)) - 1.25 * e * e * Math.sin(2 * rad(M)))
  const utcMin = (((t / 60000) % 1440) + 1440) % 1440
  const solarMin = (((utcMin + eqTime + 4 * lng) % 1440) + 1440) % 1440 // true solar time, minutes
  const hourAngle = solarMin / 4 - 180
  const cosZ = clamp(Math.sin(rad(lat)) * Math.sin(decl) + Math.cos(rad(lat)) * Math.cos(decl) * Math.cos(rad(hourAngle)), -1, 1)
  const h = 90 - deg(Math.acos(cosZ))
  // refraction lifts the sun a little near the horizon (NOAA's piecewise fit, in arc seconds)
  const tanH = Math.tan(rad(h))
  const refr = h > 85 ? 0 : h > 5 ? 58.1 / tanH - 0.07 / tanH ** 3 + 0.000086 / tanH ** 5 : h > -0.575 ? 1735 + h * (-518.2 + h * (103.4 + h * (-12.79 + h * 0.711))) : -20.772 / tanH
  return h + refr / 3600
}

/**
 * Day, dusk or night at a camera, from the sun. location 'indoor': the light does not follow
 * the sun (lightFollowsSun false), so colour is judged at any hour there (a night measurement
 * still does not stand for the day: see tier()). Without a usable position it goes by the
 * clock (06-18 day) and a black-and-white picture means night.
 * @returns {{ period: 'day' | 'dusk' | 'night', elevation: number | null, lightFollowsSun: boolean, source: 'sun' | 'clock' }}
 */
export function lightPeriod(when = new Date(), lat = SITE.lat, lng = SITE.lng, { location = null, mono = null } = {}) {
  const t = when instanceof Date ? when.getTime() : Number(when)
  const lightFollowsSun = location !== 'indoor'
  if (Number.isFinite(t) && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    const elevation = solarElevation(t, lat, lng)
    const period = elevation >= PERIOD.DAY ? 'day' : elevation >= PERIOD.NIGHT ? 'dusk' : 'night'
    return { period, elevation: Math.round(elevation * 10) / 10, lightFollowsSun, source: 'sun' }
  }
  const hour = new Date(Number.isFinite(t) ? t : Date.now()).getHours()
  return { period: mono ? 'night' : hour >= 6 && hour < 18 ? 'day' : 'night', elevation: null, lightFollowsSun, source: 'clock' }
}

/**
 * Where a camera is, for the sun: its own place on the site's street map (maps.mjs, GET
 * /api/maps: sites[site].geo.cams["nvr/ch"]), else that map's centre when the map is in use,
 * else the site default (Georgetown area).
 */
export function cameraPosition(maps, cam) {
  const geo = maps?.sites?.[cam?.site]?.geo
  const own = geo?.cams?.[`${cam?.nvr}/${cam?.ch}`]
  const ok = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng)
  if (ok(own)) return { lat: own.lat, lng: own.lng, source: 'camera' }
  if (ok(geo) && geo.cams && Object.keys(geo.cams).length) return { lat: geo.lat, lng: geo.lng, source: 'site' }
  return { ...SITE, source: 'default' }
}

// ---- the stream ---------------------------------------------------------------------------

/**
 * How hard the main stream presses against its cap (StreamMeter figures with the cap):
 *   binding    usage >= 0.90 and at the cap in >= 80% of keyframe intervals, over >= 20 s
 *   near       0.75 <= usage (and not binding)
 *   headroom   usage <= 0.50
 *   ignoresCap usage > 1.2 (the camera does not keep to its cap: LCL Cage 1.91)
 *   normal     in between; unknown without figures or a cap.
 * Grading is on the rate only: slice QP says nothing on these encoders (plan C2-1).
 */
export function classifyStream(f) {
  if (!f || typeof f.usage !== 'number' || !Number.isFinite(f.usage)) return { grade: 'unknown', usage: null, bindShare: null, enough: Boolean(f?.enough), windowS: f?.windowS ?? 0 }
  const { usage, bindShare = null, enough = false } = f
  const grade =
    usage > STREAM.IGNORES ? 'ignoresCap'
      : usage >= STREAM.BINDING && (bindShare ?? 0) >= STREAM.BIND_SHARE && enough ? 'binding'
        : usage >= STREAM.NEAR ? 'near'
          : usage <= STREAM.HEADROOM ? 'headroom'
            : 'normal'
  return { grade, usage, bindShare, enough: Boolean(enough), windowS: f.windowS ?? 0 }
}

// ---- how sure a suggestion is -----------------------------------------------------------------

// Settings that shape the picture day and night alike (D7): written to Day or Normal from a
// measurement at dusk or night, they also change the daytime picture.
const TWENTY_FOUR_HOUR = /^(bright|contrast|hue|saturation|sharpen\.|denoise\.|whiteBalance\.|fogReduction\.|WDR\.|backlightCompensation\.)/
export const twentyFourHour = (path) => TWENTY_FOUR_HOUR.test(path)
const EXPOSURE_FAMILY = /^(gain|shutter|autoExposureMode|smartIR|smartIr)\./
const fieldIn = (settings, path) => settings?.fields?.find((f) => f.path === path)

/**
 * The confirmations the server will ask for (imaging.mjs impacts(), judged on the state after
 * the change): recording-gap, restart, night-light, orientation, other-profile. For sorting
 * suggestions only: the server decides, with its own texts, when Apply is pressed.
 * @param changes { path: value }
 */
export function predictImpacts(settings, changes) {
  const paths = Object.keys(changes ?? {})
  if (!paths.length) return []
  const cur = (p) => fieldIn(settings, p)?.value
  const after = (p) => (p in changes ? changes[p] : cur(p))
  const hwdrBefore = cur('backlightCompensation.mode') === 'HWDR'
  const hwdrAfter = after('backlightCompensation.mode') === 'HWDR'
  const text = (key) => settings?.impactRules?.find((r) => r.key === key)?.text ?? key
  const out = []
  const add = (key, list) => list.length && out.push({ key, text: text(key), paths: list })
  add('recording-gap', paths.filter((p) => (p === 'backlightCompensation.mode' && hwdrBefore !== hwdrAfter) || p === 'WDR.switch' || (p === 'backlightCompensation.HWDRLevel' && hwdrAfter)))
  add('restart', hwdrAfter ? paths.filter((p) => EXPOSURE_FAMILY.test(p)) : [])
  add('night-light', paths.filter((p) => /^(illumination|Whitelight)\./.test(p)))
  add('orientation', paths.filter((p) => p === 'mirrorSwitch' || p === 'flipSwitch'))
  if (settings?.profile && settings?.active && settings.profile !== settings.active) add('other-profile', paths)
  return out
}

/**
 * tick | optional | confirm for one suggestion (a change, or an item of changes with one id):
 *   1. anything the server will ask a confirmation for: confirm;
 *   2. not a return to the factory value, and any of: a 24-hour setting written to Day or
 *      Normal while it is not day (indoors too: the indoor tag keeps colour judged at night,
 *      it does not make a night measurement stand for the day); a camera that switches
 *      profiles by itself whose report of the profile in use is not confirmed yet; an
 *      exposure or contrast rule while this browser may show the picture differently from what
 *      the camera coded (rangeMismatch true, or not known): optional, saying why;
 *   3. returns to the factory value (P1, P2a, P6a) keep their tick, naming the profile written.
 * ctx: { settings, period, lightFollowsSun, rangeMismatch, noTicks? (a reason: nothing is ticked) }
 * @returns {{ tier: 'tick' | 'optional' | 'confirm', reasons: string[], impacts: object[], note: string | null }}
 */
export function tier(s, ctx = {}) {
  const settings = ctx.settings ?? null
  const list = s.changes ?? [s]
  const changes = Object.fromEntries(list.map((c) => [c.path, c.to]))
  const impacts = predictImpacts(settings, changes)
  if (impacts.length) return { tier: 'confirm', reasons: impacts.map((i) => i.text), impacts, note: null }
  const reasons = []
  if (ctx.noTicks) reasons.push(ctx.noTicks)
  const restorative = list.every((c) => c.restorative)
  const profile = settings?.profile ?? null
  const program = settings?.schedule?.program ?? null
  if (!restorative) {
    const period = ctx.period ?? 'day'
    if ((profile === null || profile === 'day' || profile === 'normal') && list.some((c) => twentyFourHour(c.path)) && period !== 'day') {
      reasons.push(`measured at ${period}: this also changes the daytime picture${profile ? ` (the ${profileName(profile)} profile)` : ''}${ctx.lightFollowsSun === false ? ', and indoor light by day can differ too' : ''}`)
    }
    if (['auto', 'time'].includes(program) && settings?.activeVerified === false) {
      reasons.push(`the camera switches profiles by itself and has not yet been seen reporting both Day and Night, so its report of using ${profileName(settings?.active ?? profile)} is not confirmed`)
    }
    if (list.some((c) => c.exposure) && ctx.rangeMismatch !== false) {
      reasons.push(ctx.rangeMismatch ? 'this browser shows the picture with different blacks and whites from what the camera recorded' : 'it is not known how this browser shows the camera\'s blacks and whites')
    }
  }
  const base = list.every((c) => c.base === 'tick')
  const ticked = base && reasons.length === 0
  return { tier: ticked ? 'tick' : 'optional', reasons, impacts: [], note: ticked && restorative && profile ? `writes the ${profileName(profile)} profile` : null }
}

/** Suggestions grouped by id (e.g. sharpening's switch and level go together), each with its tier. */
export function sortSuggestions(changes, ctx) {
  const items = []
  for (const c of changes) {
    const it = items.find((x) => x.id === c.id)
    if (it) it.changes.push(c)
    else items.push({ id: c.id, rule: c.rule, why: c.why, downside: c.downside, target: c.target, want: c.want, restorative: c.restorative, changes: [c] })
  }
  for (const it of items) Object.assign(it, tier(it, ctx))
  return items
}

// ---- did it help? ---------------------------------------------------------------------------------

/** A figure of a measurement, and that figure's own repeatability (|set A - set B|). */
export function figureOf(target, m) {
  if (!m) return { value: null, spread: null }
  const c = m.colour
  const ab = m.ab ?? {}
  switch (target) {
    case 'mean': return { value: m.mean ?? null, spread: ab.mean ?? null }
    case 'spread': return { value: m.spread ?? null, spread: ab.spread ?? null }
    case 'black': return { value: m.black ?? null, spread: ab.black ?? null }
    case 'saturation': return { value: c?.saturation ?? null, spread: ab.saturation ?? null }
    case 'colourClip': return { value: c?.colourClip ?? null, spread: null }
    case 'cast': return { value: c?.neutral ? Math.max(Math.abs(c.neutral.r), Math.abs(c.neutral.b)) : null, spread: ab.castR === null || ab.castR === undefined ? null : Math.max(ab.castR ?? 0, ab.castB ?? 0) }
    case 'noise': return { value: m.noise?.measurable ? m.noise.value : null, spread: m.noise?.spread ?? null }
    case 'rise25': return { value: m.lines?.rise25 ?? null, spread: ab.rise25 ?? null }
    case 'overshoot': return { value: m.lines?.overshoot ?? null, spread: ab.overshoot ?? null }
    case 'highlightLoss': return { value: m.highlightLoss ?? null, spread: ab.white ?? null }
    default: return { value: null, spread: null }
  }
}

/**
 * helped | inconclusive | worse for a change that was meant to move a figure (want +1 up, -1
 * down): helped only when it moved the right way by more than twice the figure's A/B spread
 * and by more than 5% (without a spread, one set measured: more than 15%).
 */
export function verdict(before, after, spread, want) {
  if (before === null || after === null || !want) return 'inconclusive'
  const delta = after - before
  const rel = Math.abs(delta) / Math.max(Math.abs(before), 1e-6)
  const big = spread === null || spread === undefined ? rel > CONVERGE.NO_SPREAD : Math.abs(delta) > CONVERGE.SPREADS * spread && rel > CONVERGE.RELATIVE
  if (!big) return 'inconclusive'
  return Math.sign(delta) === Math.sign(want) ? 'helped' : 'worse'
}

/**
 * What Auto adjust learnt this session (and from the figures log of the last 24 h): settings
 * the camera refused or kept (not suggested again), changes that were inconclusive (not
 * suggested again this session), how many rounds have run (it stops after 3: "converged").
 * history: GET /figures entries; each may carry figures.rules { path: rule } (what the
 * measurement before it led to) and figures.refused { path: 'kept' | 'refused' | 'restart-needed' }.
 */
export class Convergence {
  constructor({ rounds = CONVERGE.ROUNDS, history = [] } = {}) {
    this.maxRounds = rounds
    this.round = 0 // measurements after an applied Auto adjust change
    this.blocked = new Map() // path -> why it is not suggested again
    this.applied = [] // [{ id, rule, paths, target, want, before, spread }] waiting for the next measurement
    this.clipCut = false // saturation was lowered for clipping in the last 24 h (P2c then waits)
    this.last = [] // the verdicts of the last judge()
    for (const e of Array.isArray(history) ? history : []) {
      const f = e?.figures ?? {}
      for (const [p, why] of Object.entries(f.refused ?? {})) if (!this.blocked.has(p)) this.blocked.set(p, `the camera ${why === 'kept' ? 'kept its value' : why === 'restart-needed' ? 'needed a restart for it' : 'refused it'} in the last 24 hours`)
      if (Object.values(f.rules ?? {}).includes('P2b')) this.clipCut = true
    }
  }

  get converged() {
    return this.round >= this.maxRounds
  }

  /**
   * After an Apply: the items sent (sortSuggestions items), the server's result
   * (result.paths: done | kept | refused | restart-needed | ...), and the measurement they came from.
   */
  noteApplied(items, result, m) {
    const status = result?.paths ?? {}
    for (const [p, st] of Object.entries(status)) {
      if (st === 'kept') this.blocked.set(p, 'the camera kept its value when it was sent')
      if (st === 'refused') this.blocked.set(p, 'the camera refused it')
      if (st === 'restart-needed') this.blocked.set(p, 'it needs a camera restart (offered separately)')
    }
    for (const it of items ?? []) {
      const paths = it.changes.map((c) => c.path)
      if (!paths.some((p) => status[p] === 'done')) continue
      if (it.rule === 'P2b') this.clipCut = true
      const { value, spread } = figureOf(it.target, m)
      this.applied.push({ id: it.id, rule: it.rule, paths, target: it.target, want: it.want ?? 0, before: value, spread })
    }
  }

  /**
   * The next measurement: a verdict for each change applied since the last one. One round.
   * Inconclusive and worse changes are not suggested again this session (a worse one would
   * otherwise come back, ticked, next to "consider Undo"). A rule with no figure to judge
   * (P1 hue back to factory) is 'not-judged'.
   */
  judge(m) {
    const out = []
    for (const a of this.applied) {
      const now = figureOf(a.target, m)
      const spread = a.spread === null && now.spread === null ? null : Math.max(a.spread ?? 0, now.spread ?? 0)
      const v = a.target ? verdict(a.before, now.value, spread, a.want) : 'not-judged'
      if (v === 'inconclusive') for (const p of a.paths) this.blocked.set(p, 'it made no clear difference last time (inconclusive)')
      if (v === 'worse') for (const p of a.paths) this.blocked.set(p, 'it made things worse last time (see Undo)')
      out.push({ id: a.id, rule: a.rule, paths: a.paths, target: a.target, before: a.before, after: now.value, spread: r3(spread), verdict: v })
    }
    this.applied = []
    this.round++
    this.last = out
    return out
  }

  /** The suggestions still worth showing: { changes, dropped: [{ id, path, why }] }. */
  filter(changes) {
    if (this.converged) return { changes: [], dropped: changes.map((c) => ({ id: c.id, path: c.path, why: `converged after ${this.maxRounds} rounds` })) }
    const keep = []
    const dropped = []
    for (const c of changes) {
      const why = this.blocked.get(c.path)
      if (why) dropped.push({ id: c.id, path: c.path, why })
      else keep.push(c)
    }
    // an item is shown whole or not at all (sharpening's switch goes with its level)
    const gone = new Set(dropped.map((d) => d.id))
    return { changes: keep.filter((c) => !gone.has(c.id)), dropped }
  }
}

// ---- the unsent changes ---------------------------------------------------------------------------

/**
 * New suggestions into the unsent changes. Ticked ones (tier 'tick') are prefilled; unsent
 * changes an admin made by hand (origin 'manual' or 'defaults') are kept and win over a
 * suggestion for the same setting; the previous measurement's own prefilled values go.
 * pending: Map path -> value; origins: Map path -> 'manual' | 'defaults' | 'auto'.
 * @returns {{ pending: Map, origins: Map, kept: string[], conflicts: { path, manual, suggested }[] }}
 */
export function mergePending(pending, origins, items) {
  const p = new Map(pending)
  const o = new Map(origins)
  for (const [path, from] of o) {
    if (from === 'auto') {
      p.delete(path)
      o.delete(path)
    }
  }
  const kept = [...p.keys()]
  const conflicts = []
  for (const it of items) {
    if (it.tier !== 'tick') continue
    for (const c of it.changes) {
      if (p.has(c.path)) {
        if (!same(p.get(c.path), c.to)) conflicts.push({ path: c.path, manual: p.get(c.path), suggested: c.to })
        continue
      }
      p.set(c.path, c.to)
      o.set(c.path, 'auto')
    }
  }
  return { pending: p, origins: o, kept, conflicts }
}

// ---- after a change -------------------------------------------------------------------------------

/**
 * How long to let the camera settle before measuring again (ms): picture values 2.5 s; gain,
 * shutter and exposure 5 s; day/night, infrared, smart IR and the night light the camera's own
 * day/night delay plus 3 s, at least 5 s. (After a camera restart the panel waits for the
 * stream to come back, then 10 s more.)
 */
export function settleMs(paths, settings) {
  let ms = 0
  for (const p of paths ?? []) {
    if (/^(IRCut|InfraredMode|smartIR\.|smartIr\.|illumination\.|Whitelight\.|ImageOverExposure\.)/.test(p)) {
      const delay = Number(fieldIn(settings, 'IRCutDelayTime')?.value)
      ms = Math.max(ms, Math.max((Number.isFinite(delay) ? delay : 0) + 3, 5) * 1000)
    } else if (/^(gain|shutter|autoExposureMode)\./.test(p)) ms = Math.max(ms, 5000)
    else ms = Math.max(ms, 2500)
  }
  return ms
}
export const SETTLE = { EVERY_MS: 500, WITHIN: 0.01, SAMPLES: 3, MAX_MS: 15_000, AFTER_RESTART_MS: 10_000 }

/** The picture has settled: the last 3 brightness samples lie within 1% of each other. */
export function isSettled(samples) {
  if (!Array.isArray(samples) || samples.length < SETTLE.SAMPLES) return false
  const last = samples.slice(-SETTLE.SAMPLES)
  const lo = Math.min(...last)
  const hi = Math.max(...last)
  return hi - lo <= SETTLE.WITHIN * Math.max(hi, 1)
}

/** Before and after can be compared only on the same stream, picture size and profile. */
export function comparable(before, after, profileBefore, profileAfter) {
  if (!before || !after) return { ok: false, why: 'nothing to compare with' }
  if (before.stream !== after.stream) return { ok: false, why: `measured on the ${before.stream ?? '?'} stream before and the ${after.stream ?? '?'} stream now` }
  if (before.width !== after.width || before.height !== after.height) return { ok: false, why: `the picture size changed (${before.width}×${before.height} → ${after.width}×${after.height})` }
  if ((profileBefore ?? null) !== (profileAfter ?? null)) return { ok: false, why: `the camera was on ${profileName(profileBefore)} before and on ${profileName(profileAfter)} now` }
  return { ok: true, why: null }
}

/**
 * Should Undo be highlighted after a change? On a brightness drop of more than 25%, a stream
 * usage rise of 0.15 or more, or a noise rise of more than twice its spread.
 * streams: { before, after } StreamMeter figures (optional).
 */
export function afterCheck(before, after, streams = {}) {
  const reasons = []
  if (before?.mean > 0 && after?.mean !== null && after?.mean !== undefined && after.mean < before.mean * 0.75) reasons.push(`the picture got much darker (average ${pct(before.mean)} → ${pct(after.mean)})`)
  const u0 = streams.before?.usage
  const u1 = streams.after?.usage
  if (typeof u0 === 'number' && typeof u1 === 'number' && u1 - u0 >= 0.15) reasons.push(`the stream uses more of its cap (${Math.round(u0 * 100)}% → ${Math.round(u1 * 100)}%)`)
  const n0 = before?.noise
  const n1 = after?.noise
  if (n0?.measurable && n1?.measurable) {
    const spread = Math.max(n0.spread ?? 0, n1.spread ?? 0)
    if (spread > 0 && n1.value - n0.value > CONVERGE.SPREADS * spread) reasons.push(`the picture got noisier (${n0.value.toFixed(2)} → ${n1.value.toFixed(2)})`)
  }
  return { undo: reasons.length > 0, reasons }
}

// ---- the display ----------------------------------------------------------------------------------

/**
 * What the browser really showed (the Worker's display self-check on the measured frames)
 * against what the measurement assumed (m.displayRange). A limited-range display where the
 * range fix was thought to be on means the display clips what the camera recorded.
 * @returns {{ range: 'limited' | 'full' | 'unknown', clips: boolean, mismatch: boolean, text: string | null }}
 */
export function displayCheck(m) {
  const range = m?.selfCheck?.range ?? 'unknown'
  const coded = m?.coded ?? {}
  const wouldClip = (coded.le16 ?? 0) - (coded.le4 ?? 0) > 0.01 || (coded.ge235 ?? 0) - (coded.ge251 ?? 0) > 0.01
  const fixDidNotTake = range === 'limited' && m?.displayRange === 'full'
  const clips = range === 'limited' || (range === 'unknown' && m?.displayRange === 'limited')
  // not known (a drawn picture: rangeMismatch null) counts as a mismatch for the exposure rules
  const mismatch = m?.rangeMismatch !== false || (fixDidNotTake && wouldClip)
  // "shows the full range" only when the range fix is known to be on and the check agrees; a
  // 'full' verdict without the fix is not claimed (the Measurer's own assumption stands)
  const text = m?.planes === 'rgba'
    ? 'Measured on the picture as this browser draws it (the camera\'s own values could not be read): exposure rules stay optional.'
    : range === 'limited' || (m?.rangeMismatch && m?.displayRange === 'limited')
      ? 'This browser clips shadows and highlights the camera recorded (limited-range display).'
      : range === 'full' && m?.rangeFixed
        ? 'This browser shows the full range the camera recorded (range fix on).'
        : null
  return { range, clips, mismatch, text }
}

// ---- suggestions ----------------------------------------------------------------------------------

/** Seconds of an exposure label as the camera names it: "1/30" -> 0.0333, "1" -> 1. */
export function exposureSeconds(label) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*s?\s*$/.exec(String(label ?? ''))
  if (!m) return null
  const v = m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1])
  return Number.isFinite(v) && v > 0 ? v : null
}

/** How a setting's value reads (switch on/off, index and exposure-time labels). */
export function valueText(f, v) {
  if (!f) return String(v)
  if (f.kind === 'switch') return v === true || v === 'true' ? 'on' : 'off'
  if (f.kind === 'index') return f.labels?.[Number(v)] ?? String(v)
  if (f.kind === 'usec') return f.options?.find((o) => o.us === Number(v))?.label ?? `${v} µs`
  return String(v)
}

const LEVEL_ORDER = ['lowest', 'lower', 'medium', 'higher', 'highest']
const pixels = (res) => String(res ?? '').split('x').map(Number).reduce((a, b) => a * b, 1)

/**
 * Suggested changes for one camera from one measurement (plan §4.6).
 * m: Measurer result (null: only what the settings alone show). settings: the panel's view
 * (GET /image). ctx: {
 *   period, lightFollowsSun, location   (lightPeriod(); location from the camera notes)
 *   stream        StreamMeter figures of the main stream, with its cap (qoi)
 *   streamInfo    GET /stream's stream (current, qoiList, digitalDefault, caps, candidate, why)
 *   sub           measured on the sub stream (noise, focus and sharpening are then not judged)
 *   lens          GET /lens's lens;  focusRef: { rise25, at } daytime edge reference
 *   history       a Convergence (P2c waits 24 h after a clipping cut);  canH265, fps
 * }
 * Choices are named by label (e.g. "auto", "HLC"), never by index, so other models work too.
 * @returns {{ changes: object[], left: { rule, text }[], info: { rule, text }[], stream: object[], lens: object | null }}
 *   change: { id, rule, path, label, from, to, fromText, toText, why, downside, target, want,
 *             restorative, base: 'tick' | 'optional', exposure }
 */
export function suggest(m, settings, ctx = {}) {
  const fields = settings?.fields ?? []
  const F = new Map(fields.map((f) => [f.path, f]))
  const val = (p) => F.get(p)?.value
  const def = (p) => F.get(p)?.default ?? null
  const changes = []
  const left = []
  const info = []
  const lp = ctx.period ? { period: ctx.period, lightFollowsSun: ctx.lightFollowsSun ?? ctx.location !== 'indoor' } : lightPeriod(new Date(), SITE.lat, SITE.lng, { location: ctx.location, mono: m?.mono })
  const period = lp.period
  const indoor = ctx.location === 'indoor'
  const sub = Boolean(ctx.sub) || m?.stream === 'sub'
  const grade = classifyStream(ctx.stream).grade
  const binding = !sub && grade === 'binding'
  const noise = m?.noise ?? null
  const noiseOk = Boolean(noise?.measurable && noise.comparable && !sub)
  const noiseHigh = noiseOk && noiseBand(noise.value) === 'high'
  const noiseLow = noiseOk && noiseBand(noise.value) === 'low'

  const item = (id, rule, why, downside, extra = {}) => ({ id, rule, why, downside, base: 'optional', target: null, want: 0, restorative: false, exposure: false, ...extra })
  /** Adds one setting change of an item; false when the camera has no such setting or it is already so. */
  const add = (it, path, to) => {
    const f = F.get(path)
    if (!f || changes.some((c) => c.path === path)) return false
    if (f.kind === 'range') {
      if (!Number.isFinite(to)) return false
      to = clamp(Math.round(to), f.min, f.max)
    } else if (f.kind === 'select') {
      if (!f.options.includes(to)) return false
    } else if (f.kind === 'switch') {
      if (typeof to !== 'boolean') return false
    } else return false // index, exposure time, times: never suggested
    if (same(f.value, to)) return false
    changes.push({ id: it.id, rule: it.rule, path, label: f.label, from: f.value, to, fromText: valueText(f, f.value), toText: valueText(f, to), why: it.why, downside: it.downside, target: it.target, want: it.want, restorative: it.restorative, base: it.base, exposure: it.exposure })
    return true
  }

  if (m && sub) left.push({ rule: 'sub', text: 'Measured on the sub stream (smaller picture): noise, focus and sharpening are not judged.' })

  // ---- picture: back to the factory values the data supports
  if (m && !m.mono) {
    const hue = F.get('hue')
    if (hue && hue.default !== null && hue.value !== hue.default) {
      add(item('P1', 'P1', `Hue shifts every colour; the camera's factory value (${hue.default}) is the neutral one.`, 'If hue was set on purpose to offset a lamp colour, that correction goes.', { restorative: true, base: 'tick' }), 'hue', hue.default)
    }
    const sat = F.get('saturation')
    const clip = m.colour?.colourClip ?? null
    if (sat && sat.default !== null && clip !== null) {
      if (sat.value > sat.default && clip < 0.01) {
        add(item('P2a', 'P2a', `Saturation is above the camera's factory value (${sat.value} vs ${sat.default}) and no colour is clipping: more looks punchier but less true.`, 'Colours look a little less vivid.', { restorative: true, base: 'tick', target: 'saturation', want: -1 }), 'saturation', sat.default)
      } else if (clip > 0.02 && sat.value > sat.default - 16) {
        // -8 a round while clipping, down to the floor (factory value - 16): two rounds at most.
        // Optional: a move away from the factory value, with a threshold from night clips only
        // (plan D10: only returns to factory values are ticked until daylight clips calibrate it)
        add(item('P2b', 'P2b', `Strong colours are clipping (${pc1(clip)} of the picture): they lose their shading.`, 'Colours look a little less vivid; the clipping threshold is not calibrated for daylight yet.', { target: 'colourClip', want: -1 }), 'saturation', Math.max(sat.value - 8, sat.default - 16))
      } else if (sat.value < sat.default && clip < 0.005) {
        if (ctx.history?.clipCut) left.push({ rule: 'P2c', text: 'Saturation was lowered for clipping in the last 24 hours: not raised again yet.' })
        else add(item('P2c', 'P2c', `Saturation is below the camera's factory value (${sat.value} vs ${sat.default}) and nothing is clipping.`, 'If it was lowered on purpose (for example against a lamp colour), that goes.', { target: 'saturation', want: 1 }), 'saturation', sat.default)
      }
    }
  } else if (m?.mono) {
    left.push({ rule: 'colour', text: 'Infrared (black-and-white) picture: colour, hue and saturation are not judged.' })
  }

  // ---- picture: brightness and contrast (coded values). Optional (plan D10, §8): the targets
  // come from dusk and night clips; daytime exposure targets need daylight clips first
  if (m && F.has('bright')) {
    const near = m.clip?.near ?? 0
    const hl = m.highlightLoss ?? 0
    if (m.mean < EXPOSURE.DARK) {
      if (near >= EXPOSURE.GLARE) left.push({ rule: 'P3', text: `Dark picture (average ${pct(m.mean)}), but infrared glare close to the camera (${pc1(near)}): brightness is not raised.` })
      else if (hl >= 0.02) left.push({ rule: 'P3', text: `Dark picture (average ${pct(m.mean)}), but ${pc1(hl)} of it is already overlit: brightness is not raised.` })
      else {
        const step = Math.min(m.mono ? 4 : 8, Math.max(2, (110 - m.mean) / 5))
        add(item('P3', 'P3', `The picture is dark (average ${pct(m.mean)}).`, m.mono ? 'At night more brightness also shows more noise, so only a little.' : 'Brighter also shows more noise; highlights may clip.', { target: 'mean', want: 1, exposure: true }), 'bright', val('bright') + step)
      }
    } else if (m.mean > EXPOSURE.BRIGHT && (m.black ?? 0) < 0.02) {
      const step = Math.min(8, Math.max(2, (m.mean - 140) / 5))
      add(item('P3', 'P3', `The picture is bright (average ${pct(m.mean)}): highlights lose detail.`, 'Shadows get darker.', { target: 'mean', want: -1, exposure: true }), 'bright', val('bright') - step)
    }
    if (period === 'day' && F.has('contrast') && m.spread < EXPOSURE.FLAT && hl < 0.01 && (m.black ?? 0) < 0.01) {
      const step = Math.min(8, Math.max(2, (160 - m.spread) / 6))
      add(item('P4', 'P4', `The picture looks flat: it uses ${pct(m.spread)} of the brightness range.`, 'More contrast also darkens shadows and brightens highlights; in haze it can look harsh.', { target: 'spread', want: 1, exposure: true }), 'contrast', val('contrast') + step)
    }
  }

  // ---- picture: sharpening and noise reduction
  const sh = F.get('sharpen.value')
  const shOn = F.has('sharpen.switch') ? val('sharpen.switch') === true : true
  if (m && sh && !sub) {
    const high = sh.default !== null && shOn && sh.value >= sh.default + 0.25 * (sh.max - sh.min)
    const sw = F.get('sharpen.switch')
    if (high) {
      const it = binding
        ? item('P6a', 'P6a', `Sharpening is set by hand well above the factory level (${sh.value} vs ${sh.default}) and the stream is at its bitrate cap: the encoder spends bits on halos and grain.`, 'Edges look slightly softer; the camera goes back to its own sharpening.', { restorative: true, base: 'tick', target: 'overshoot', want: -1 })
        : item('P6b', 'P6b', `Sharpening is set by hand well above the factory level (${sh.value} vs ${sh.default}): that adds halos around edges and uses more bitrate.`, 'Edges look slightly softer.', { target: 'overshoot', want: -1 })
      // the factory state is the switch AND the level (TVT: off/128, the page's own Defaults)
      if (sw && sw.default !== null) add(it, 'sharpen.switch', sw.default)
      add(it, 'sharpen.value', sh.default)
    } else if (noiseHigh && shOn && sh.default !== null && sh.value > sh.default) {
      add(item('P6c', 'P6c', `The picture is grainy (${noise.value.toFixed(2)}) and sharpening is above its factory level (${sh.value} vs ${sh.default}): sharpening makes grain stronger.`, 'Edges look slightly softer.', { target: 'noise', want: -1 }), 'sharpen.value', sh.default)
    }
  }
  const dn = F.get('denoise.switch')
  const dv = F.get('denoise.value')
  if (m && !sub && dn) {
    if (noiseHigh && dn.value === false) {
      // on H.264 the figure includes the encoder's own noise (Drive Way 1.14): said so
      const grain = m.codec === 'h264' ? `${noise.value.toFixed(2)}, high; on H.264 this figure includes encoder noise` : `${noise.value.toFixed(2)}, high for these cameras`
      const it = item('P7', 'P7', `The picture is grainy (${grain}): set a fixed noise-reduction level (camera default ${dv?.default ?? '?'}).`, 'The camera may already filter noise with this off; a fixed level can smear moving people. Needs a supervised test.', { target: 'noise', want: -1 })
      if (add(it, 'denoise.switch', true) && dv && dv.default !== null) add(it, 'denoise.value', dv.default)
    } else if (dn.value === true && dv && dv.default !== null && dv.value > dv.default + 32) {
      add(item('P7', 'P7', `Noise reduction is fixed well above its factory level (${dv.value} vs ${dv.default}).`, 'A high fixed level smears moving people; the picture may look a little grainier.', { target: 'noise', want: 1 }), 'denoise.value', dv.default)
    }
  }
  if (dn && dn.value === false && dv && dv.default !== null && dv.value > dv.default + 32) {
    info.push({ rule: 'P7', text: `Noise reduction is off, but its level is stored at ${dv.value} (factory ${dv.default}); it would apply if switched on.` })
  }
  if (m && !sub && noise) {
    if (!noise.measurable) left.push({ rule: 'noise', text: `Noise not measurable (${noise.reason ?? 'no usable frames'}): noise rules left alone.` })
    else if (!noise.comparable) left.push({ rule: 'noise', text: `Noise not comparable with the other cameras (${noise.notComparable}): noise rules left alone.` })
  }

  // ---- colour: only when the light can be judged
  const gate = colourGate(m, { period, indoor })
  if (m && !m.mono && gate) left.push({ rule: 'colour', text: gate })
  if (m && !gate) {
    const wb = F.get('whiteBalance.mode')
    const cast = m.colour.neutral
    const amount = Math.max(Math.abs(cast.r), Math.abs(cast.b))
    if (wb && !['auto', 'manual'].includes(wb.value) && wb.options.includes('auto')) {
      add(item('C1', 'C1', `White balance is a fixed preset ("${wb.value}"); auto follows the light.${amount >= COLOUR.CAST ? ` The picture has a ${castName(cast)} cast.` : ''}`, 'A preset holds its colour when the light changes; auto may shift with the light.', { target: 'cast', want: -1 }), 'whiteBalance.mode', 'auto')
    } else if (wb?.value === 'manual' && amount >= COLOUR.CAST && F.has('whiteBalance.red') && F.has('whiteBalance.blue')) {
      const it = item('C2', 'C2', `The picture has a ${castName(cast)} cast with white balance set by hand.`, 'The size of the step is not calibrated: measure again after applying.', { target: 'cast', want: -1 })
      add(it, 'whiteBalance.red', val('whiteBalance.red') - clamp(cast.r * 60, -12, 12))
      add(it, 'whiteBalance.blue', val('whiteBalance.blue') - clamp(cast.b * 60, -12, 12))
    }
  }

  // ---- exposure: information only, and the gain limit
  const up = F.get('shutter.upLimit')
  if (up?.kind === 'index') {
    const secs = exposureSeconds(up.shown)
    const fps = ctx.fps ?? ctx.stream?.fps ?? ctx.streamInfo?.current?.fps ?? null
    const f = fps || 20
    if (secs !== null && secs > 1 / f) {
      const faster = ['1/15', '1/30'].filter((l) => up.labels.includes(l) && exposureSeconds(l) < secs)
      const stops = faster.length ? Math.log2(secs / exposureSeconds(faster.at(-1))) : null
      info.push({
        rule: 'E1',
        text: `Slowest shutter ${up.shown} s at ${f} fps${fps ? '' : ' (assumed)'}: at night moving objects blur across up to ${Math.round(secs * f)} frames.${faster.length ? ` A faster limit (${faster.join(' or ')}) makes night pictures up to ${stops.toFixed(1)} stops darker or noisier.` : ''} Needs a night check of this camera first.`
      })
    }
  }
  const agc = F.get('gain.AGC')
  if (m && agc && !sub && noiseOk && agcActive(settings)) {
    const usage = typeof ctx.stream?.usage === 'number' ? ctx.stream.usage : null
    if (noiseHigh && binding && m.mean >= 90 && agc.value > 30) {
      add(item('E3', 'E3', `Grainy (${noise.value.toFixed(2)}) and at the bitrate cap, with enough light (average ${pct(m.mean)}): a lower gain limit means less grain.`, 'Darker in poor light.', { target: 'noise', want: -1 }), 'gain.AGC', Math.max(30, agc.value - 10))
    } else if (m.mean < 70 && noiseLow && usage !== null && usage < 0.7 && agc.value < 70) {
      add(item('E3', 'E3', `Dark (average ${pct(m.mean)}) with little grain and room in the stream: a higher gain limit brightens poor light.`, 'More grain in poor light, and a higher bitrate.', { target: 'mean', want: 1 }), 'gain.AGC', Math.min(70, agc.value + 10))
    }
  }

  // ---- night: all optional
  if (m) {
    const near = m.clip?.near ?? 0
    const smart = F.get('smartIR.switch')
    if (m.mono && near >= EXPOSURE.GLARE && smart && smart.value === false) {
      const it = item('N1', 'N1', `Infrared glare close to the camera (${pc1(near)} of the picture): smart IR dims the infrared light on near objects.`, 'Distant parts of the scene may get darker at night.', { target: 'highlightLoss', want: -1 })
      if (add(it, 'smartIR.switch', true)) add(it, 'smartIR.level', Math.max(1, F.get('smartIR.level')?.min ?? 1))
    } else if (m.mono && near >= EXPOSURE.GLARE && !F.has('smartIR.switch') && !F.has('smartIr.mode')) {
      const blc = F.get('backlightCompensation.mode')
      if (blc && ['OFF', 'BLC'].includes(blc.value)) {
        add(item('N2-hlc', 'N2', `Infrared glare close to the camera (${pc1(near)} of the picture): highlight compensation (HLC) holds back the brightest parts.`, 'Bright areas are masked darker; the rest of the picture may look flatter.', { target: 'highlightLoss', want: -1 }), 'backlightCompensation.mode', 'HLC')
      }
    }
    const ioe = F.get('ImageOverExposure.ImageOverExposureMode')
    if (ioe && val('illumination.illuminationMode') === 'whiteLight' && (m.highlightLoss ?? 0) >= 0.01) {
      add(item('N2-light', 'N2', `Overlit areas under the white light (${pc1(m.highlightLoss)} of the picture): over-exposure control dims it on near objects.`, 'The floodlit area gets a little darker.', { target: 'highlightLoss', want: -1 }), 'ImageOverExposure.ImageOverExposureMode', 'lowStrength')
    }
    if (val('InfraredMode') === 'off' && period === 'night' && m.mean < EXPOSURE.DIM_IR) {
      add(item('N3', 'N3', `Dark at night (average ${pct(m.mean)}) with the infrared light off.`, 'The picture turns black-and-white when the infrared light is on.', { target: 'mean', want: 1 }), 'InfraredMode', 'auto')
    }
  }
  const delay = F.get('IRCutDelayTime')
  if (val('IRCutMode') === 'auto' && delay && delay.value < 10) {
    add(item('N4', 'N4', `The camera switches between colour and infrared after only ${delay.value} s of changed light: headlights and passing lamps can flip it back and forth.`, 'It takes up to 10 s to switch at dusk and dawn.'), 'IRCutDelayTime', 10)
  }

  // ---- focus: a note, never a change
  let lens = null
  const lit = m ? period === 'day' || (indoor && !m.mono && m.mean >= FOCUS.LIT_MEAN) : false
  if (m && !sub) {
    const rise = m.lines?.rise25
    if (!lit) left.push({ rule: 'focus', text: 'Focus not judged at night (and autofocus in the dark hunts).' })
    else if (typeof rise === 'number' && rise > FOCUS.SOFT && m.width >= FOCUS.MIN_WIDTH && m.stream !== 'sub') {
      const ref = ctx.focusRef?.rise25
      info.push({ rule: 'focus', text: `Edges rise over ${rise.toFixed(2)} px: the picture may be out of focus (sharpening and compression can also soften edges).${typeof ref === 'number' ? ` Daytime reference: ${ref.toFixed(2)} px.` : ''}` })
    }
  }
  if (ctx.lens?.supported) {
    lens = { supported: true, lightOk: lit, why: lit ? null : m ? 'Focus now needs good light: by day, or a lit scene in colour' : 'Measure the picture first (Auto adjust)', rise25: m?.lines?.rise25 ?? null }
  }

  // a dependent setting only while its controller (after this suggestion) has the value it
  // works with, or when the controller changes in the same suggestion (the server's needs rule)
  const kept = changes.filter((c) => {
    const need = F.get(c.path)?.needs
    const ctl = need && F.get(need.path)
    if (!ctl) return true
    const partner = changes.find((x) => x.path === need.path && x.id === c.id)
    if (partner) return true
    const shown = need.label && ctl.kind === 'index' ? ctl.labels[Number(ctl.value)] : ctl.value
    return 'eq' in need ? same(shown, need.eq) : !same(shown, need.ne)
  })
  return { changes: kept, left, info, stream: streamBox(ctx, period, sub), lens }
}

/** null when colour can be judged, else why not (plan §4.6 Colour). */
function colourGate(m, { period, indoor }) {
  if (!m) return 'not measured'
  if (m.mono) return 'Infrared (black-and-white) picture: white balance left alone.'
  const c = m.colour
  if (!c || !c.neutral) return 'Too few grey areas to judge colour: white balance left alone.'
  const zone = Math.max(c.zoneSpread?.r ?? 0, c.zoneSpread?.b ?? 0)
  if ((c.disagreement ?? 1) > COLOUR.CAST_DISAGREE || zone > COLOUR.ZONE_SPREAD || (c.neutralShare ?? 0) < COLOUR.NEUTRAL_SHARE) {
    const sodium = castName(c.neutral) === 'yellow-orange' ? ' (orange sodium or other lamp light colours the picture: that is the light, not the camera)' : ''
    return `Mixed or uncertain lighting: white balance left alone${sodium}.`
  }
  if (!indoor && period !== 'day') return `Measured at ${period}, under lamp light: white balance is judged by daylight only (left alone).`
  return null
}

/** The gain limit applies only in automatic gain (gain.mode label "auto"). */
function agcActive(settings) {
  const gm = settings?.fields?.find((f) => f.path === 'gain.mode')
  return !gm || (gm.kind === 'index' ? gm.labels[gm.value] === 'auto' : gm.value === 'auto')
}

/**
 * The Recording-quality box (plan §4.6 Stream box): candidates only, one list step per round,
 * never lowering anything. Each: { id, rule, change, from, why, downside, ticked, encoderRestart }.
 * Applying one goes through its own estimate and confirmation (POST /stream), never from ticks.
 */
function streamBox(ctx, period, sub) {
  const si = ctx.streamInfo
  const out = []
  if (!si) return out
  const note = (text) => {
    out.push({ id: 'S', rule: 'S', note: text })
    return out
  }
  if (!si.candidate) return note(`Not offered: ${si.why ?? 'this stream cannot be changed here'}.`)
  if (sub) return note('Measured on the sub stream: the recording stream\'s rate is not known here.')
  const g = classifyStream(ctx.stream)
  if (g.grade === 'ignoresCap') return note(`Not offered: the camera does not keep to its bitrate cap (it sends ${g.usage.toFixed(2)}× the cap).`)
  const cur = si.current ?? {}
  const list = [...(si.qoiList ?? [])].sort((a, b) => a - b)
  const nextStep = (v) => list.find((x) => x > v) ?? null
  const night = period !== 'day'
  const storage = 'The NVR keeps fewer days of recordings (see the estimate before applying).'
  const push = (id, change, why, downside, ticked = false) => {
    const from = Object.fromEntries(Object.keys(change).map((k) => [k, cur[k]]))
    out.push({ id, rule: id, change, from, why, downside, ticked, encoderRestart: 'enct' in change || 'res' in change })
  }
  const def = si.digitalDefault
  let qoiDone = false
  if (def && cur.QoI < def) {
    const to = list.find((x) => x >= def) ?? null
    if (to && to > cur.QoI) {
      push('S1', { QoI: to }, `The bitrate cap (${cur.QoI} kbit/s) is below the NVR's own default for this codec and size (${def}).`, storage, true)
      qoiDone = true
    }
  }
  if (!g.enough) note(`Measuring the stream (${Math.floor(g.windowS ?? 0)} of 20 s): the rate is judged after 20 s.`)
  else if (!qoiDone && (g.grade === 'binding' || g.grade === 'near')) {
    const to = nextStep(cur.QoI)
    if (to) {
      const why = g.grade === 'binding'
        ? `The stream is at its cap (${Math.round(g.usage * 100)}%, in ${Math.round((g.bindShare ?? 0) * 100)}% of keyframe intervals): the encoder is starved of bits.`
        : `The stream is close to its cap (${Math.round(g.usage * 100)}%).`
      push(g.grade === 'binding' ? 'S2' : 'S2b', { QoI: to }, why, night ? `Measured at ${period}: noise inflates the rate. ${storage}` : storage, g.grade === 'binding')
    }
  } else if (g.grade === 'headroom') {
    const levels = si.caps?.levels ?? []
    const order = levels.length ? levels : LEVEL_ORDER
    const i = order.indexOf(cur.level)
    if (i >= 0 && i + 1 < order.length) push('S3', { level: order[i + 1] }, `The stream uses only ${Math.round(g.usage * 100)}% of its cap: a higher quality level can use the room.`, storage)
  }
  const sup = si.caps?.supEnct ?? []
  if (cur.enct === 'h265p' && sup.includes('h265')) push('S4', { enct: 'h265' }, 'H.265+ sends keyframes rarely and holds still areas: plain H.265 is steadier to seek in and to judge.', `The camera restarts its encoder (a few seconds without video), and the rate rises. ${storage}`)
  if (cur.enct === 'h264' && sup.includes('h265') && ctx.canH265 === true) push('S6', { enct: 'h265' }, 'H.265 gives a better picture for the same bitrate, and this browser can play it.', `The camera restarts its encoder (a few seconds without video); browsers without H.265 then fall back to the sub stream. ${storage}`)
  // A camera on a fixed rate pays the same for an empty yard at 3 am as for a busy one: the
  // encoder pads every frame to hit its number. Measured on 2026-09-25, nvr-2's fixed-rate cameras
  // held 4.0, 3.8 and 3.2 Mb/s around the clock while its variable ones averaged under 1, and that
  // NVR had 128 Mb of its 192 Mb budget permanently spent, refused streams, and left eleven
  // cameras recording nothing.
  //
  // The cap does not move, so a busy scene encodes exactly as it does now. Not ticked by default:
  // it is a change of what the cap means, and worth choosing deliberately rather than sweeping up
  // with everything else.
  const bitTypes = si.caps?.bitTypes ?? []
  if (cur.bitType === 'CBR' && bitTypes.includes('VBR')) {
    push('S7', { bitType: 'VBR' },
      'The camera sends the same bitrate whether anything is happening or not. Letting it vary frees bandwidth on the NVR and keeps more days on its disk, and a busy scene still gets the full cap.',
      'A still scene is recorded with fewer bits, so fine detail in an empty picture is softer. The cap, and so the quality of anything moving, is unchanged.')
  }
  const res = [...(si.caps?.resolutions ?? [])].sort((a, b) => pixels(b.res) - pixels(a.res))
  const top = res[0]
  if (top && cur.res && pixels(top.res) > pixels(cur.res) && !(top.fps && top.fps < cur.fps)) {
    const ratio = pixels(top.res) / pixels(cur.res)
    const need = list.find((v) => v >= cur.QoI * ratio) ?? list.at(-1)
    if (need) {
      push('S5', { res: top.res, QoI: Math.max(need, cur.QoI) }, `The camera can send ${top.res} (${ratio.toFixed(2)}× the pixels of ${cur.res}); the bitrate cap rises with it, so each pixel keeps its share.`, `The camera restarts its encoder, and recordings take ${ratio.toFixed(1)}× the space at the cap. ${storage}`)
    }
  }
  return out
}

/** The measured stream in a line: "4.9 of 5.1 Mbit/s (96%), at the cap in 9 of 10 keyframe intervals". */
export function streamLine(f) {
  if (!f) return null
  if (!f.enough) return `measuring the stream (${Math.floor(f.windowS ?? 0)} of 20 s)`
  if (!f.qoi || typeof f.kbps !== 'number') return typeof f.kbps === 'number' ? `${(f.kbps / 1000).toFixed(1)} Mbit/s (cap unknown)` : 'measuring the stream'
  const n = f.gops?.length ?? 0
  const bound = Math.round((f.bindShare ?? 0) * n)
  return `${(f.kbps / 1000).toFixed(1)} of ${(f.qoi / 1000).toFixed(1)} Mbit/s (${Math.round((f.usage ?? 0) * 100)}%), at the cap in ${bound} of ${n} ${f.mode === 'windows' ? '10 s windows' : 'keyframe intervals'}`
}

/** One change for POST /stream from the ticked Recording-quality items (the larger cap wins). */
export function streamChangeOf(items) {
  const change = {}
  for (const it of items ?? []) {
    for (const [k, v] of Object.entries(it.change ?? {})) {
      if (k === 'QoI') change.QoI = Math.max(change.QoI ?? 0, v)
      else change[k] = v
    }
  }
  return change
}

/**
 * The resolution dropdown for the Recording-quality box: every size the camera offers, widest
 * first, each marked whether it can be chosen here. The app only keeps or raises the resolution
 * (planChange refuses to lower it, and it never lowers the frame rate), so a smaller size, or one
 * whose top frame rate is below the current fps, is offered disabled with the reason — the whole
 * range stays visible so it is clear what the camera can do and why a size is out.
 * @returns {{ res: string, px: number, selected: boolean, disabled: boolean, reason: string|null }[]}
 */
export function resolutionOptions(si) {
  const cur = si?.current ?? {}
  const curPx = pixels(cur.res)
  const list = [...(si?.caps?.resolutions ?? [])].sort((a, b) => pixels(b.res) - pixels(a.res))
  return list.map((r) => {
    const px = pixels(r.res)
    let reason = null
    if (!si?.candidate) reason = si?.why ?? 'this stream cannot be changed here'
    else if (px < curPx) reason = 'smaller than now — the app does not lower resolution (do that on the NVR)'
    else if (r.fps && cur.fps && r.fps < cur.fps) reason = `this size tops out at ${r.fps} fps, below the current ${cur.fps}`
    return { res: r.res, px, selected: r.res === cur.res, disabled: Boolean(reason), reason }
  })
}

/**
 * A manual Recording-quality item for choosing `target` from the resolution dropdown: the same
 * shape streamBox's S5 makes, with the bitrate cap raised in step with the extra pixels so each
 * pixel keeps its share (planChange refuses a bigger picture at the same cap). null when `target`
 * is the current size or cannot be offered.
 */
export function resolutionChange(si, target) {
  const cur = si?.current ?? {}
  if (!target || target === cur.res) return null
  const opt = resolutionOptions(si).find((o) => o.res === target)
  if (!opt || opt.disabled) return null
  const list = [...(si?.qoiByRes?.[target] ?? si?.qoiList ?? [])].sort((a, b) => a - b)
  const ratio = pixels(target) / (pixels(cur.res) || 1)
  const need = list.find((v) => v >= cur.QoI * ratio) ?? list.at(-1) ?? cur.QoI
  const QoI = Math.max(need, cur.QoI)
  const change = QoI > cur.QoI ? { res: target, QoI } : { res: target }
  const from = Object.fromEntries(Object.keys(change).map((k) => [k, cur[k]]))
  const capNote = QoI > cur.QoI ? `; the bitrate cap rises with it (${cur.QoI} → ${QoI} kbit/s), so each pixel keeps its share` : ''
  return {
    id: 'Sres',
    rule: 'manual',
    change,
    from,
    why: `Set by hand: ${target} is ${ratio.toFixed(2)}× the pixels of ${cur.res}${capNote}.`,
    downside: `The camera restarts its encoder (a few seconds without video), and recordings take about ${ratio.toFixed(1)}× the space at the cap. The NVR keeps fewer days of recordings (see the estimate before applying).`,
    ticked: true,
    encoderRestart: true
  }
}

/** A short hash of the settings measured with (for the figures log). */
export function settingsHash(settings) {
  const s = (settings?.fields ?? []).map((f) => `${f.path}=${f.value}`).join(';')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * A short name of the browser for the figures log ("Edge 128", "Chrome 128", "Firefox 130",
 * "Safari 17"), so the display fix can be judged per browser. nav: navigator (or a stand-in).
 */
export function browserLabel(nav) {
  const brands = nav?.userAgentData?.brands ?? []
  const pick = ['Microsoft Edge', 'Google Chrome', 'Opera', 'Chromium'].map((n) => brands.find((b) => b.brand === n)).find(Boolean)
  if (pick) return `${pick.brand.replace(/^(Microsoft|Google) /, '')} ${String(pick.version).split('.')[0]}`.slice(0, 40)
  const ua = String(nav?.userAgent ?? '')
  const m = /Edg\/(\d+)/.exec(ua) ?? /OPR\/(\d+)/.exec(ua) ?? /Firefox\/(\d+)/.exec(ua) ?? /Chrome\/(\d+)/.exec(ua) ?? /Version\/(\d+)[\d.]* .*Safari/.exec(ua)
  if (!m) return null
  const name = m[0].startsWith('Edg') ? 'Edge' : m[0].startsWith('OPR') ? 'Opera' : m[0].startsWith('Firefox') ? 'Firefox' : m[0].startsWith('Chrome') ? 'Chrome' : 'Safari'
  return `${name} ${m[1]}`
}

/**
 * The figures posted to the figures log (numbers, flags and short labels only), for P5
 * calibration, Convergence across sessions and the camera notes (monoNightAt, focusRef).
 * Also what the calibration has to tell apart: the browser, whether the range fix was on,
 * coded or drawn (RGBA) planes, and whether the grab was complete.
 */
export function figuresForLog(m, { stream = null, rules = null, refused = null, round = 0, browser = null } = {}) {
  const n = m?.noise ?? {}
  const c = m?.colour ?? null
  const out = {
    mean: m?.mean ?? null,
    spread: m?.spread ?? null,
    black: m?.black ?? null,
    white: m?.white ?? null,
    highlightLoss: m?.highlightLoss ?? null,
    near: m?.clip?.near ?? null,
    mono: Boolean(m?.mono),
    neutralChroma: m?.neutralChroma ?? null,
    saturation: c?.saturation ?? null,
    colourClip: c?.colourClip ?? null,
    disagreement: c?.disagreement ?? null,
    castR: c?.neutral?.r ?? null,
    castB: c?.neutral?.b ?? null,
    noise: n.measurable ? n.value : null,
    noiseSpread: n.spread ?? null,
    skip: n.skip ?? null,
    rise25: m?.lines?.rise25 ?? null,
    overshoot: m?.lines?.overshoot ?? null,
    block: m?.lines?.block ?? null,
    displayBlack: m?.display?.black ?? null,
    displayWhite: m?.display?.white ?? null,
    rangeMismatch: m?.rangeMismatch === null || m?.rangeMismatch === undefined ? null : Boolean(m.rangeMismatch),
    aligned: Boolean(m?.aligned),
    frames: m?.frames ?? 0,
    planes: m?.planes === 'rgba' ? 'rgba' : 'coded',
    rangeFixed: Boolean(m?.rangeFixed),
    grabComplete: m?.grab ? Boolean(m.grab.complete) : null,
    browser: typeof browser === 'string' ? browser.slice(0, 40) : null,
    round,
    usage: stream?.usage ?? null,
    bindShare: stream?.bindShare ?? null,
    kbps: stream?.kbps ?? null,
    qoi: stream?.qoi ?? null
  }
  if (rules && Object.keys(rules).length) out.rules = rules
  if (refused && Object.keys(refused).length) out.refused = refused
  for (const [k, v] of Object.entries(out)) if (typeof v === 'number' && !Number.isFinite(v)) out[k] = null
  return out
}

/**
 * The Day profile reports "in use" while the picture is black-and-white (infrared) on a camera
 * that switches by itself: the report is wrong, so nothing is ticked.
 */
export function contradiction(m, settings) {
  if (!m?.mono) return null
  const program = settings?.schedule?.program
  if (settings?.active === 'day' && (program === 'auto' || program === 'time')) {
    return 'The camera reports its Day profile, but the picture is black-and-white (infrared): its report of the profile in use looks wrong, so nothing is ticked.'
  }
  return null
}

/** Plain text for a verdict, for the report. */
export const VERDICTS = { helped: 'helped', inconclusive: 'inconclusive (within the measurement\'s own spread)', worse: 'worse: consider Undo (not suggested again)', 'not-judged': 'not judged (no figure for this rule)' }

export const _test = { colourGate, streamBox, agcActive }
export { NOISE_BANDS }
