// Offline tests for Auto adjust's rules (public/auto-adjust.js): where the sun is, how the
// stream is graded, how sure each suggestion is (tick / optional / confirm), whether a change
// helped, how long to let the picture settle, and the suggestions themselves, on the camera
// settings the server really parses (imaging.mjs, from saved NVR answers) and the figures the
// lab measured on real video (test/fixtures/figures). Nothing is sent anywhere.
//   node cctv/test/auto-adjust.test.mjs
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-auto-adjust-test-'))
const { _test: img } = await import('../imaging.mjs')
const { _test: notesTest } = await import('../camera-notes.mjs')
const aa = await import('../public/auto-adjust.js')
const {
  Convergence, SITE, afterCheck, cameraPosition, classifyStream, comparable, contradiction, displayCheck, exposureSeconds, figuresForLog, isSettled,
  lightPeriod, mergePending, predictImpacts, settleMs, solarElevation, sortSuggestions, streamChangeOf, streamLine, suggest, tier, verdict
} = aa

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const here = import.meta.dirname
const xml = (dir, nvr, file) => readFileSync(join(here, 'fixtures', dir, nvr, `${file}.xml`), 'utf8')
/** The panel's view of a camera (GET /image) from a saved answer: nvr1/image-0000000E -> channel 0x0E. */
function camera(dir, nvr, file, extra = {}) {
  const s = img.parseSettings(xml(dir, nvr, file), `{${file.slice(6, 14)}-0000-0000-0000-000000000000}`)
  if (!s.ok) throw new Error(`${file}: ${s.errorCode}`)
  return { nvr: { id: nvr, name: nvr, device: 'test:6036' }, camera: { ch: 0, name: file }, profile: s.profile, profiles: s.profiles, active: s.profile, activeVerified: true, schedule: s.schedule, info: s.info, location: null, sections: [], fields: s.fields, defaults: {}, undo: null, restart: [], impactRules: [], ...extra }
}
const fig = (name) => JSON.parse(readFileSync(join(here, 'fixtures', 'figures', `${name}.json`), 'utf8'))
const fld = (s, p) => s.fields.find((x) => x.path === p)
const byPath = (changes) => Object.fromEntries(changes.map((c) => [c.path, c.to]))
const withValues = (s, values) => ({ ...s, fields: s.fields.map((x) => (x.path in values ? { ...x, value: values[x.path] } : x)) })
const local = (iso) => new Date(`${iso}-04:00`) // Guyana: UTC-4, no daylight saving

// ---- where the sun is ----------------------------------------------------------------------------
{
  const G = [SITE.lat, SITE.lng]
  check('site default is the Georgetown area (6.80 N, 58.16 W)', SITE.lat === 6.8 && SITE.lng === -58.16)
  // near midsummer the sun sets about 18:10 here: 18:30 is dusk, 19:00 is night
  const p1830 = lightPeriod(local('2026-06-21T18:30:00'), ...G)
  const p1900 = lightPeriod(local('2026-06-21T19:00:00'), ...G)
  check('lightPeriod: Georgetown 18:30 local -> dusk', p1830.period === 'dusk' && p1830.source === 'sun', `elevation ${p1830.elevation}`)
  check('lightPeriod: Georgetown 19:00 local -> night', p1900.period === 'night', `elevation ${p1900.elevation}`)
  check('lightPeriod: noon -> day', lightPeriod(local('2026-09-23T12:00:00'), ...G).period === 'day')
  // the critique's own figures for the capture evening (23 Sep): about -14 at 18:43, -19 at 19:00
  const e1843 = solarElevation(local('2026-09-23T18:43:00'), ...G)
  const e1900 = solarElevation(local('2026-09-23T19:00:00'), ...G)
  check('solar elevation on 23 Sep matches the critique (-14 at 18:43, -19 at 19:00, within 1 degree)', Math.abs(e1843 + 14) <= 1 && Math.abs(e1900 + 19) <= 1, `${e1843.toFixed(1)}, ${e1900.toFixed(1)}`)
  check('  so 18:30 on 23 Sep is already night (sun about -11)', lightPeriod(local('2026-09-23T18:30:00'), ...G).period === 'night')
  check('solar elevation: equator at the June solstice noon is about 66.6 degrees', Math.abs(solarElevation(new Date('2026-06-21T12:00:00Z'), 0, 0) - 66.56) < 0.3)
  const clock = lightPeriod(local('2026-09-23T12:00:00'), Number.NaN, Number.NaN)
  check('no position: by the clock (12:00 -> day)', clock.period === 'day' && clock.source === 'clock')
  check('  and a black-and-white picture means night', lightPeriod(local('2026-09-23T12:00:00'), Number.NaN, Number.NaN, { mono: true }).period === 'night')
  check('indoor: the light does not follow the sun', lightPeriod(new Date(), ...G, { location: 'indoor' }).lightFollowsSun === false && lightPeriod(new Date(), ...G, { location: 'outdoor' }).lightFollowsSun === true)
  const maps = { sites: { Wharf: { geo: { lat: 6.81, lng: -58.17, cams: { 'nvr1/13': { lat: 6.805, lng: -58.165 } } } }, Empty: { geo: { lat: 30, lng: -40, cams: {} } } } }
  check('camera position: its own place on the street map', cameraPosition(maps, { site: 'Wharf', nvr: 'nvr1', ch: 13 }).source === 'camera')
  check('  else the map centre, when the map has cameras', cameraPosition(maps, { site: 'Wharf', nvr: 'nvr1', ch: 2 }).source === 'site')
  check('  else the site default (an unused map\'s centre is ignored)', cameraPosition(maps, { site: 'Empty', nvr: 'nvr1', ch: 2 }).lat === SITE.lat && cameraPosition(null, {}).source === 'default')
}

// ---- the stream ------------------------------------------------------------------------------------
const gate = fig('north-gate')
{
  check('classifyStream: North Gate (0.96 of the cap in every keyframe interval) is binding', classifyStream(gate.stream.looped).grade === 'binding')
  check('  PW Exit (0.29) has headroom', classifyStream(fig('pw-exit').stream.looped).grade === 'headroom')
  check('  0.80 is near the cap', classifyStream({ usage: 0.8, bindShare: 0.1, enough: true }).grade === 'near')
  check('  1.91 ignores its cap (LCL Cage)', classifyStream({ usage: 1.91, bindShare: 1, enough: true }).grade === 'ignoresCap')
  check('  0.96 before 20 s is not binding yet (near)', classifyStream({ usage: 0.96, bindShare: 1, enough: false }).grade === 'near')
  check('  0.95 but at the cap in few intervals: near', classifyStream({ usage: 0.95, bindShare: 0.5, enough: true }).grade === 'near')
  check('  no cap or figures: unknown', classifyStream(null).grade === 'unknown' && classifyStream({ usage: null }).grade === 'unknown')
  check('streamLine: the panel\'s plain line', streamLine(gate.stream.looped) === '4.9 of 5.1 Mbit/s (96%), at the cap in 13 of 13 keyframe intervals', streamLine(gate.stream.looped))
}

// ---- confirmations and tiers -------------------------------------------------------------------------
const omar = camera('imaging', 'nvr-2', 'image-00000017') // HWDR on, slowest shutter 1/4
const gateDay = camera('imaging', 'nvr1', 'image-0000000E', { activeVerified: false }) // Day, program auto, never seen on Night
const lockers = camera('imaging', 'nvr-2', 'image-00000014') // HWDR, white balance "indoor"
const pwExitS = camera('imaging', 'nvr1', 'image-00000002')
const roadway = camera('imaging', 'nvr1', 'image-0000001A') // IP619E5W: smart IR, day/night switch
const bondSE = camera('imaging', 'nvr-2', 'image-00000004') // white light
const jpbS = camera('imaging', 'nvr-2', 'image-00000018')
const pwEntranceS = camera('auto-adjust', 'nvr1', 'image-00000004')
const lclS = camera('auto-adjust', 'nvr1', 'image-00000007')
{
  const keys = (s, ch) => predictImpacts(s, ch).map((i) => i.key).join()
  check('predictImpacts: HWDR camera + gain limit -> restart', keys(omar, { 'gain.AGC': 40 }) === 'restart')
  check('  Backlight OFF -> HWDR -> recording gap (and restart with a gain change)', keys(pwExitS, { 'backlightCompensation.mode': 'HWDR' }) === 'recording-gap' && keys(pwExitS, { 'backlightCompensation.mode': 'HWDR', 'gain.AGC': 40 }) === 'recording-gap,restart')
  check('  night light and mirror', keys(bondSE, { 'illumination.illuminationMode': 'smart' }) === 'night-light' && keys(pwExitS, { mirrorSwitch: true }) === 'orientation')
  check('  a profile the camera is not using', keys({ ...pwExitS, profile: 'night', active: 'normal' }, { bright: 60 }) === 'other-profile')

  const c = (path, to, extra = {}) => ({ id: 'X', rule: 'X', path, to, base: 'tick', restorative: false, exposure: false, ...extra })
  const T = (ch, ctx) => tier(ch, ctx).tier
  check('tier: HWDR camera + gain limit -> confirm', T(c('gain.AGC', 40, { base: 'optional' }), { settings: omar, period: 'day' }) === 'confirm')
  check('tier: brightness on Day, measured at night -> optional ("also changes the daytime picture")', T(c('bright', 56, { exposure: true }), { settings: { ...gateDay, activeVerified: true }, period: 'night' }) === 'optional' && /daytime picture/.test(tier(c('bright', 56), { settings: { ...gateDay, activeVerified: true }, period: 'night' }).reasons.join()))
  check('  the same by day, display known to match -> tick', T(c('bright', 56, { exposure: true }), { settings: { ...gateDay, activeVerified: true }, period: 'day', rangeMismatch: false }) === 'tick')
  check('  ... but not while it is unknown how the browser shows it (rangeMismatch null: a drawn picture)', T(c('bright', 56, { exposure: true }), { settings: { ...gateDay, activeVerified: true }, period: 'day', rangeMismatch: null }) === 'optional' && /not known how this browser shows/.test(tier(c('bright', 56, { exposure: true }), { settings: { ...gateDay, activeVerified: true }, period: 'day', rangeMismatch: null }).reasons.join()))
  check('  Normal profile at dusk -> optional', T(c('bright', 56), { settings: pwExitS, period: 'dusk' }) === 'optional')
  check('  Night profile at night: not a daytime change -> tick', T(c('bright', 56), { settings: { ...pwExitS, profile: 'night', active: 'night' }, period: 'night' }) === 'tick')
  check('  indoor at night: the indoor tag does not make a night measurement stand for the day -> optional', T(c('bright', 56), { settings: pwExitS, period: 'night', lightFollowsSun: false }) === 'optional' && /indoor light by day can differ/.test(tier(c('bright', 56), { settings: pwExitS, period: 'night', lightFollowsSun: false }).reasons.join()))
  check('  a low-light-only setting at night (day/night delay) -> tick', T(c('IRCutDelayTime', 10), { settings: roadway, period: 'night' }) === 'tick')
  check('tier: unverified program=auto -> not ticked, with the reason', T(c('bright', 56), { settings: gateDay, period: 'day' }) === 'optional' && /not confirmed/.test(tier(c('bright', 56), { settings: gateDay, period: 'day' }).reasons.join()))
  const restor = tier({ changes: [c('sharpen.switch', false, { restorative: true }), c('sharpen.value', 128, { restorative: true })] }, { settings: gateDay, period: 'night' })
  check('  ... except returns to the factory value, which say which profile they write', restor.tier === 'tick' && restor.note === 'writes the Day profile', JSON.stringify(restor))
  check('tier: an exposure rule while the display differs from the coded picture -> optional', T(c('bright', 56, { exposure: true }), { settings: pwExitS, period: 'day', rangeMismatch: true }) === 'optional' && T(c('hue', 50), { settings: pwExitS, period: 'day', rangeMismatch: true }) === 'tick')
  check('tier: nothing is ticked when the profile report contradicts the picture', T(c('hue', 50, { restorative: true }), { settings: pwExitS, period: 'day', noTicks: 'contradiction' }) === 'optional')
  check('tier: an optional rule stays optional', T(c('bright', 56, { base: 'optional' }), { settings: pwExitS, period: 'day' }) === 'optional')
}

// ---- did it help? -------------------------------------------------------------------------------------
{
  check('verdict: moved the right way by more than twice its spread (and 5%) -> helped', verdict(60, 66, 2, 1) === 'helped')
  check('  within twice its spread -> inconclusive', verdict(60, 63, 2, 1) === 'inconclusive')
  check('  over twice the spread but under 5% -> inconclusive', verdict(200, 205, 2, 1) === 'inconclusive')
  check('  the wrong way -> worse', verdict(60, 50, 2, 1) === 'worse')
  check('  no spread (one set): needs more than 15%', verdict(0.5, 0.45, null, -1) === 'inconclusive' && verdict(0.5, 0.4, null, -1) === 'helped')
  const m1 = { mean: 60, ab: { mean: 2 }, noise: { measurable: true, value: 0.9, spread: 0.05 } }
  const conv = new Convergence()
  const items = [{ id: 'P3', rule: 'P3', target: 'mean', want: 1, changes: [{ path: 'bright' }] }, { id: 'P7', rule: 'P7', target: 'noise', want: -1, changes: [{ path: 'denoise.switch' }] }, { id: 'P6a', rule: 'P6a', target: 'overshoot', want: -1, changes: [{ path: 'sharpen.switch' }, { path: 'sharpen.value' }] }]
  conv.noteApplied(items, { paths: { bright: 'done', 'denoise.switch': 'done', 'sharpen.switch': 'kept', 'sharpen.value': 'kept' } }, m1)
  check('Convergence: a kept value is not suggested again', conv.blocked.has('sharpen.value') && conv.applied.length === 2)
  const v = conv.judge({ mean: 68, ab: { mean: 1.5 }, noise: { measurable: true, value: 0.88, spread: 0.06 } })
  check('  judged against the A/B spread: brightness helped, noise inconclusive', v.find((x) => x.rule === 'P3').verdict === 'helped' && v.find((x) => x.rule === 'P7').verdict === 'inconclusive', JSON.stringify(v))
  const kept = conv.filter([{ id: 'P7', path: 'denoise.switch' }, { id: 'P3', path: 'bright' }, { id: 'P6a', path: 'sharpen.switch' }, { id: 'P6a', path: 'sharpen.value' }])
  check('  inconclusive and kept ones are dropped, the rest stay', kept.changes.map((x) => x.path).join() === 'bright' && kept.dropped.length === 3)
  const pair = new Convergence()
  pair.blocked.set('sharpen.value', 'x')
  check('  an item goes whole: sharpening\'s switch goes with its blocked level', pair.filter([{ id: 'P6a', path: 'sharpen.switch' }, { id: 'P6a', path: 'sharpen.value' }]).changes.length === 0)
  conv.judge({ mean: 68 })
  conv.judge({ mean: 68 })
  check('  after three rounds: converged, nothing more suggested', conv.converged && conv.filter([{ id: 'P3', path: 'bright' }]).changes.length === 0)
  const hist = new Convergence({ history: [{ figures: { refused: { 'whiteBalance.mode': 'kept' }, rules: { saturation: 'P2b' } } }] })
  check('  the figures log of the last 24 h: refused paths and a clipping cut are remembered', hist.blocked.has('whiteBalance.mode') && hist.clipCut)
  // a change that made things worse is not suggested (and pre-ticked) again next round
  const w = new Convergence()
  w.noteApplied([{ id: 'P3', rule: 'P3', target: 'mean', want: 1, changes: [{ path: 'bright' }] }, { id: 'P1', rule: 'P1', target: null, want: 0, changes: [{ path: 'hue' }] }], { paths: { bright: 'done', hue: 'done' } }, { mean: 70, ab: { mean: 1 } })
  const wv = w.judge({ mean: 60, ab: { mean: 1 } })
  check('Convergence: "worse" blocks the setting for the session, with the reason', wv.find((x) => x.rule === 'P3').verdict === 'worse' && /made things worse/.test(w.blocked.get('bright')) && w.filter([{ id: 'P3', path: 'bright' }]).changes.length === 0)
  check('  a rule with no figure to judge (P1 hue) is "not judged", not "inconclusive"', wv.find((x) => x.rule === 'P1').verdict === 'not-judged' && aa.VERDICTS['not-judged'] === 'not judged (no figure for this rule)' && !w.blocked.has('hue'))
}

// ---- after a change ----------------------------------------------------------------------------------------
{
  check('settleMs: picture values 2.5 s', settleMs(['bright', 'saturation'], pwExitS) === 2500)
  check('  gain, shutter, exposure 5 s', settleMs(['gain.AGC'], pwExitS) === 5000 && settleMs(['bright', 'shutter.upLimit'], pwExitS) === 5000)
  check('  day/night and infrared: the camera\'s delay + 3 s, at least 5 s', settleMs(['InfraredMode'], roadway) === 5000 && settleMs(['smartIR.switch'], withValues(roadway, { IRCutDelayTime: 8 })) === 11000)
  check('  nothing changed: no wait', settleMs([], pwExitS) === 0)
  check('isSettled: three samples within 1%', isSettled([100, 120, 101, 100.5, 100.2]) && !isSettled([100, 103, 106]) && !isSettled([100, 100]))
  check('afterCheck: a brightness drop over 25% highlights Undo', afterCheck({ mean: 120 }, { mean: 80 }).undo && !afterCheck({ mean: 120 }, { mean: 100 }).undo)
  check('  a usage rise of 0.15', afterCheck({ mean: 100 }, { mean: 100 }, { before: { usage: 0.7 }, after: { usage: 0.86 } }).undo)
  check('  a noise rise over twice its spread', afterCheck({ mean: 100, noise: { measurable: true, value: 0.5, spread: 0.03 } }, { mean: 100, noise: { measurable: true, value: 0.6, spread: 0.02 } }).undo && !afterCheck({ mean: 100, noise: { measurable: true, value: 0.5, spread: 0.03 } }, { mean: 100, noise: { measurable: true, value: 0.55, spread: 0.03 } }).undo)
  const a = { stream: 'main', width: 3840, height: 2160 }
  check('comparable: same stream, size and profile only', comparable(a, { ...a }, 'day', 'day').ok && !comparable(a, { ...a, stream: 'sub' }, 'day', 'day').ok && !comparable(a, { ...a, width: 1920 }, 'day', 'day').ok && !comparable(a, a, 'day', 'night').ok)

  const items = [{ tier: 'tick', changes: [{ path: 'hue', to: 50 }, { path: 'bright', to: 56 }] }, { tier: 'optional', changes: [{ path: 'contrast', to: 58 }] }]
  const r = mergePending(new Map([['bright', 60], ['sharpen.value', 100]]), new Map([['bright', 'manual'], ['sharpen.value', 'auto']]), items)
  check('mergePending: ticked ones prefilled, optional ones not', r.pending.get('hue') === 50 && !r.pending.has('contrast'))
  check('  a value changed by hand is kept (and listed), the old prefilled one goes', r.pending.get('bright') === 60 && r.kept.join() === 'bright' && !r.pending.has('sharpen.value') && r.conflicts.length === 1 && r.origins.get('hue') === 'auto')
  const col = mergePending(new Map([['hue', 44], ['saturation', 52], ['sharpen.value', 100]]), new Map([['hue', 'colour'], ['saturation', 'colour'], ['sharpen.value', 'auto']]), items)
  check('  the colour check: its unsent values are kept (and listed), and win over a suggestion', col.pending.get('hue') === 44 && col.pending.get('saturation') === 52 && col.kept.join() === 'hue,saturation' && col.origins.get('hue') === 'colour' && col.conflicts.length === 1 && col.conflicts[0].path === 'hue' && !col.pending.has('sharpen.value') && col.origins.get('bright') === 'auto')
}

// ---- suggestions: real figures, real settings ------------------------------------------------------------
const siGate = { candidate: true, why: null, current: { enct: 'h265', res: '3840x2160', fps: 20, QoI: 5120, level: 'higher', bitType: 'VBR' }, qoiList: [1024, 2048, 3072, 4096, 5120, 6144, 8192, 10240], digitalDefault: 5120, caps: { supEnct: ['h264', 'h265', 'h265p'], levels: ['lowest', 'lower', 'medium', 'higher', 'highest'], resolutions: [{ res: '3840x2160', fps: 20 }, { res: '1920x1080', fps: 30 }] } }
{
  const s = suggest(gate.figures, gateDay, { period: 'night', stream: gate.stream.looped, streamInfo: siGate })
  const p6 = s.changes.filter((c) => c.id === 'P6a')
  check('North Gate: P6a (sharpening back to factory) when the stream is binding', p6.length === 2, s.changes.map((c) => `${c.id}:${c.path}`).join())
  check('  P6a restores the switch too: on/199 -> off/128', byPath(p6)['sharpen.switch'] === false && byPath(p6)['sharpen.value'] === 128)
  const items = sortSuggestions(s.changes, { settings: gateDay, period: 'night' })
  check('  and it is ticked, although the camera\'s Day report is unconfirmed and it is night', items.find((i) => i.id === 'P6a')?.tier === 'tick')
  check('  nothing else is ticked', items.filter((i) => i.tier === 'tick').length === 1, items.map((i) => `${i.id}:${i.tier}`).join())
  const s2 = s.stream.find((x) => x.id === 'S2')
  check('  Recording quality: S2 +1 list step, pre-ticked (5120 -> 6144), with the night downside', s2?.ticked && s2.change.QoI === 6144 && /noise inflates/.test(s2.downside), JSON.stringify(s.stream))
  check('  colour at night outdoors: left alone', s.left.some((l) => /daylight only/.test(l.text)))
  const near = suggest(gate.figures, gateDay, { period: 'night', stream: { ...gate.stream.looped, usage: 0.8, bindShare: 0.2 }, streamInfo: siGate })
  check('North Gate not binding: P6b, optional', near.changes.some((c) => c.id === 'P6b') && sortSuggestions(near.changes, { settings: gateDay, period: 'night' }).find((i) => i.id === 'P6b').tier === 'optional')
  check('  and S2b (+1, not ticked)', near.stream.some((x) => x.id === 'S2b' && !x.ticked))
  const sub = suggest({ ...gate.figures, stream: 'sub' }, gateDay, { period: 'night', stream: gate.stream.looped, sub: true, streamInfo: siGate })
  check('sub stream: no sharpening, noise or focus rules, and the report says so', !sub.changes.some((c) => /^(sharpen|denoise|gain)\./.test(c.path)) && sub.left.some((l) => /sub stream/.test(l.text)) && sub.stream.every((x) => x.note))
}
{
  const f = fig('pw-entrance')
  const s = suggest(f.figures, pwEntranceS, { period: 'night', stream: f.stream.looped })
  check('PW Entrance: estimators disagree -> no white balance change', !s.changes.some((c) => c.path.startsWith('whiteBalance.')))
  check('  "mixed or uncertain lighting" is left alone', s.left.some((l) => /Mixed or uncertain lighting/.test(l.text)), s.left.map((l) => l.text).join(' | '))
  const day = suggest(f.figures, withValues(pwEntranceS, { 'whiteBalance.mode': 'indoor' }), { period: 'day', stream: f.stream.looped })
  check('  even by day with a fixed preset: no white balance change', !day.changes.some((c) => c.path.startsWith('whiteBalance.')))
}
{
  const f = fig('lcl-destuffing-door')
  const s = suggest(f.figures, lclS, { period: 'night', stream: f.stream.looped, location: 'indoor' })
  check('LCL Destuffing Door: no brightness raise (mean at or above 85, IR glare)', !s.changes.some((c) => c.path === 'bright'), s.changes.map((c) => c.path).join())
  check('  black-and-white: colour not judged', s.left.some((l) => /Infrared/.test(l.text)))
  const dark = suggest({ ...f.figures, mean: 70 }, lclS, { period: 'night' })
  check('  darker, but IR glare close by: still no raise, and it says why', !dark.changes.some((c) => c.path === 'bright') && dark.left.some((l) => /glare/.test(l.text)))
  const noGlare = suggest({ ...f.figures, mean: 70, clip: { ...f.figures.clip, near: 0 }, highlightLoss: 0 }, lclS, { period: 'night' })
  check('  darker without glare: a small raise, at most +4 on an infrared picture', byPath(noGlare.changes).bright === fld(lclS, 'bright').value + 4, JSON.stringify(byPath(noGlare.changes)))
}
{
  const s = suggest(null, omar, { streamInfo: null, fps: 20 })
  check('Omar River: no clip, settings only: information and no change', s.changes.length === 0 && s.info.some((i) => i.rule === 'E1'), JSON.stringify(s))
  const e1 = s.info.find((i) => i.rule === 'E1')?.text ?? ''
  check('  E1 names 1/4, 1/15 and 1/30 by label, and the darker/noisier downside', /1\/4 s at 20 fps/.test(e1) && /1\/15 or 1\/30/.test(e1) && /2\.9 stops darker or noisier/.test(e1) && /5 frames/.test(e1), e1)
  // labels in another order on some other model: still found by label
  const up = fld(omar, 'shutter.upLimit')
  const shuffled = { ...omar, fields: omar.fields.map((x) => (x.path === 'shutter.upLimit' ? { ...up, labels: ['1/30', '1/4', '1/15', ...up.labels.filter((l) => !['1/30', '1/4', '1/15'].includes(l))], value: 1, shown: '1/4' } : x)) }
  const e1b = suggest(null, shuffled, { fps: 20 }).info.find((i) => i.rule === 'E1')?.text ?? ''
  check('  choices by label, never by index', /1\/15 or 1\/30/.test(e1b) && /1\/4 s/.test(e1b), e1b)
  check('  no E1 when the slowest shutter is 1/30 (the other 31 cameras)', !suggest(null, pwExitS, { fps: 20 }).info.some((i) => i.rule === 'E1'))
  check('exposureSeconds: "1/30" and "1"', Math.abs(exposureSeconds('1/30') - 1 / 30) < 1e-9 && exposureSeconds('1') === 1 && exposureSeconds('fast') === null)
}
{
  const f = fig('pw-exit')
  const s = suggest(f.figures, pwExitS, { period: 'night', stream: f.stream.looped })
  check('PW Exit: noise not measurable, said so, and no noise rule', s.left.some((l) => /Noise not measurable/.test(l.text)) && !s.changes.some((c) => ['P7', 'E3', 'P6c'].includes(c.rule)), s.left.map((l) => l.text).join(' | '))
}
{
  const f = fig('jpb-door')
  check('JPB DOOR: the fixture keeps coded values above 235 (native full range)', f.figures.coded.max > 235 && f.figures.coded.ge235 > 0.01)
  const lens = { supported: true, focusType: 'manual', IrchangeFocus: false, timeInterval: 60 }
  const s = suggest(f.figures, jpbS, { period: 'night', location: 'indoor', lens })
  check('  soft edges but a dim scene at night: focus not judged, Focus now not in good light', s.left.some((l) => /Focus not judged/.test(l.text)) && s.lens?.supported && s.lens.lightOk === false)
  const lit = suggest({ ...f.figures, mean: 120 }, jpbS, { period: 'night', location: 'indoor', lens, focusRef: { rise25: 1.9, at: 'x' } })
  check('  a lit indoor scene: the focus note, with the daytime reference and the other causes', lit.info.some((i) => i.rule === 'focus' && /out of focus/.test(i.text) && /sharpening and compression/.test(i.text) && /1\.90/.test(i.text)) && lit.lens.lightOk)
}

// ---- suggestions: the rules one by one (synthetic figures on real settings) -------------------------------
const colourM = (extra = {}) => ({
  width: 3840, height: 2160, stream: 'main', frames: 8, mono: false, mean: 110, spread: 200, black: 0, white: 0.001, highlightLoss: 0, clip: { surface: 0, near: 0, light: 0, lights: 0, text: 0 }, rangeMismatch: false,
  colour: { saturation: 0.2, colourClip: 0, neutral: { r: 0.01, b: 0.01 }, zoneSpread: { r: 0.05, b: 0.05 }, disagreement: 0.03, neutralShare: 0.9 },
  noise: { measurable: true, comparable: true, value: 0.4, spread: 0.02 }, lines: { rise25: 1.8, overshoot: 0.2 }, ab: null, ...extra
})
{
  // saturation clipping, two rounds by day: 50 -> 42 -> 34, never below the default - 16
  let s = pwExitS
  const clip = colourM({ colour: { ...colourM().colour, colourClip: 0.03 } })
  const r1 = suggest(clip, s, { period: 'day' })
  const i1 = sortSuggestions(r1.changes, { settings: s, period: 'day' }).find((i) => i.id === 'P2b')
  check('saturation clipping (P2b): 50 -> 42, optional even by day (a move away from factory; plan D10)', i1?.changes[0].to === 42 && i1.tier === 'optional', JSON.stringify(i1))
  s = withValues(s, { saturation: 42 })
  const r2 = suggest(clip, s, { period: 'day' })
  check('  second round, still clipping: 42 -> 34', byPath(r2.changes).saturation === 34)
  s = withValues(s, { saturation: 34 })
  check('  third round: stays at the floor (default - 16)', !('saturation' in byPath(suggest(clip, s, { period: 'day' }).changes)))
  check('  at night: optional', sortSuggestions(suggest(clip, pwExitS, { period: 'night' }).changes, { settings: pwExitS, period: 'night' }).find((i) => i.id === 'P2b').tier === 'optional')
  const high = withValues(pwExitS, { saturation: 60, hue: 55 })
  const r = suggest(colourM(), high, { period: 'night' })
  const items = sortSuggestions(r.changes, { settings: high, period: 'night' })
  check('P1 hue and P2a saturation back to factory: ticked even at night', byPath(r.changes).hue === 50 && byPath(r.changes).saturation === 50 && items.filter((i) => ['P1', 'P2a'].includes(i.id)).every((i) => i.tier === 'tick'))
  check('  not on an infrared picture', !suggest(colourM({ mono: true, colour: null }), high, { period: 'night' }).changes.some((c) => c.rule === 'P1' || c.rule === 'P2a'))
  const low = withValues(pwExitS, { saturation: 40 })
  check('P2c saturation below factory -> default, optional; waits 24 h after a clipping cut', byPath(suggest(colourM(), low, { period: 'day' }).changes).saturation === 50 && !suggest(colourM(), low, { period: 'day', history: new Convergence({ history: [{ figures: { rules: { saturation: 'P2b' } } }] }) }).changes.some((c) => c.path === 'saturation'))
}
{
  const gated = (colour) => suggest(colourM({ colour: { ...colourM().colour, ...colour, neutral: { r: 0.15, b: -0.12 } } }), lockers, { period: 'day' })
  check('colour gate passes by day: C1 fixed "indoor" preset -> auto, optional', byPath(gated({}).changes)['whiteBalance.mode'] === 'auto' && sortSuggestions(gated({}).changes, { settings: lockers, period: 'day' }).find((i) => i.id === 'C1').tier === 'optional')
  const bad = gated({ disagreement: 0.24 })
  check('  estimators disagree (0.24): white balance left alone', !bad.changes.some((c) => c.path.startsWith('whiteBalance.')) && bad.left.some((l) => /Mixed or uncertain/.test(l.text)))
  check('  a yellow-orange cast gets the sodium-light note', bad.left.some((l) => /sodium/.test(l.text)))
  check('  zone spread 0.4 or neutral share 0.3: left alone', !gated({ zoneSpread: { r: 0.4, b: 0 } }).changes.some((c) => c.path.startsWith('whiteBalance.')) && !gated({ neutralShare: 0.3 }).changes.some((c) => c.path.startsWith('whiteBalance.')))
  check('  outdoor at dusk: left alone; indoor at night: judged', !suggest(colourM(), lockers, { period: 'dusk' }).changes.some((c) => c.path === 'whiteBalance.mode') && suggest(colourM(), lockers, { period: 'night', location: 'indoor' }).changes.some((c) => c.path === 'whiteBalance.mode'))
  const manual = withValues(pwExitS, { 'whiteBalance.mode': 'manual' })
  const c2 = suggest(colourM({ colour: { ...colourM().colour, neutral: { r: 0.15, b: -0.1 } } }), manual, { period: 'day' })
  check('C2 manual white balance: red and blue nudged against the cast (optional)', byPath(c2.changes)['whiteBalance.red'] === 41 && byPath(c2.changes)['whiteBalance.blue'] === 56, JSON.stringify(byPath(c2.changes)))
  check('  C3 (auto -> manual) never', !suggest(colourM({ colour: { ...colourM().colour, neutral: { r: 0.3, b: -0.3 } } }), pwExitS, { period: 'day' }).changes.some((c) => c.path === 'whiteBalance.mode'))
}
{
  const dark = suggest(colourM({ mean: 60 }), pwExitS, { period: 'day' })
  check('P3 dark colour picture by day: +min(8, (110 - mean)/5) = +8, optional (daytime exposure targets need daylight clips)', byPath(dark.changes).bright === 58 && sortSuggestions(dark.changes, { settings: pwExitS, period: 'day', rangeMismatch: false })[0].tier === 'optional')
  {
    // the review's cases (exp/sk3-rules.mjs): by day outdoors and indoor at night, nothing but
    // returns to factory values is ticked
    const clipDark = colourM({ mean: 70, spread: 180, colour: { ...colourM().colour, colourClip: 0.03 } })
    const day = sortSuggestions(suggest(clipDark, pwExitS, { period: 'day', lightFollowsSun: true }).changes, { settings: pwExitS, period: 'day', lightFollowsSun: true, rangeMismatch: false })
    const night = sortSuggestions(suggest(clipDark, pwExitS, { period: 'night', location: 'indoor', lightFollowsSun: false }).changes, { settings: pwExitS, period: 'night', lightFollowsSun: false, rangeMismatch: false })
    check('  by day outdoors and indoor at night: P2b and P3 suggested, neither ticked', ['P2b', 'P3'].every((r) => day.some((i) => i.rule === r) && night.some((i) => i.rule === r)) && ![...day, ...night].some((i) => i.tier === 'tick'), [...day, ...night].map((i) => `${i.rule}:${i.tier}`).join())
  }
  check('  optional while the display differs from the coded picture', sortSuggestions(suggest(colourM({ mean: 60, rangeMismatch: true }), pwExitS, { period: 'day' }).changes, { settings: pwExitS, period: 'day', rangeMismatch: true }).find((i) => i.id === 'P3').tier === 'optional')
  check('  bright picture: down', byPath(suggest(colourM({ mean: 190 }), pwExitS, { period: 'day' }).changes).bright === 42)
  check('  highlights already lost: not raised', !suggest(colourM({ mean: 60, highlightLoss: 0.03 }), pwExitS, { period: 'day' }).changes.some((c) => c.path === 'bright'))
  check('P4 flat by day: contrast up, optional; never at night', byPath(suggest(colourM({ spread: 120 }), pwExitS, { period: 'day' }).changes).contrast === 57 && !suggest(colourM({ spread: 120 }), pwExitS, { period: 'night' }).changes.some((c) => c.path === 'contrast'))
  const noisy = colourM({ noise: { measurable: true, comparable: true, value: 1.15, spread: 0.03 } })
  const p7 = suggest(noisy, pwExitS, { period: 'night' })
  check('P7 high noise, switch off: "a fixed noise-reduction level", optional, with the supervised-test downside', byPath(p7.changes)['denoise.switch'] === true && /fixed noise-reduction level/.test(p7.changes.find((c) => c.rule === 'P7').why) && /supervised test/.test(p7.changes.find((c) => c.rule === 'P7').downside) && sortSuggestions(p7.changes, { settings: pwExitS, period: 'day' }).find((i) => i.id === 'P7').tier === 'optional')
  check('  not on a picture that is not comparable', !suggest({ ...noisy, noise: { ...noisy.noise, comparable: false, notComparable: 'sub stream' } }, pwExitS, { period: 'night' }).changes.some((c) => c.rule === 'P7'))
  const e3 = suggest(noisy, omar, { period: 'night', stream: gate.stream.looped })
  const e3i = sortSuggestions(e3.changes, { settings: omar, period: 'night' }).find((i) => i.id === 'E3')
  check('E3 noisy + binding + enough light: gain limit 50 -> 40, and on an HWDR camera it needs confirmation', e3i?.changes[0].to === 40 && e3i.tier === 'confirm', JSON.stringify(e3i))
  check('  gain mode, shutter and exposure mode are never suggested', !e3.changes.some((c) => /^(gain\.mode|shutter\.|autoExposureMode\.)/.test(c.path)))
  const jpBondLike = withValues(pwExitS, { 'denoise.value': 235 })
  check('P7 info: a stored level with the switch off is a note, not a change', suggest(colourM(), jpBondLike, { period: 'night' }).info.some((i) => /stored at 235/.test(i.text)))
}
{
  const irGlare = colourM({ mono: true, colour: null, mean: 100, clip: { surface: 0, near: 0.02, light: 0, lights: 0, text: 0 }, highlightLoss: 0.02 })
  const n1 = suggest(irGlare, roadway, { period: 'night' })
  check('N1 infrared glare with smart IR: switch it on (optional)', byPath(n1.changes)['smartIR.switch'] === true && sortSuggestions(n1.changes, { settings: roadway, period: 'night' }).find((i) => i.id === 'N1').tier === 'optional')
  const n2 = suggest(irGlare, pwExitS, { period: 'night' })
  check('N2 glare without smart IR: backlight HLC (chosen by label)', byPath(n2.changes)['backlightCompensation.mode'] === 'HLC')
  check('  never on an HWDR camera (it would switch HWDR off)', !suggest(irGlare, lockers, { period: 'night' }).changes.some((c) => c.path === 'backlightCompensation.mode'))
  const n2l = suggest(colourM({ highlightLoss: 0.02 }), bondSE, { period: 'night' })
  check('N2 white light with overlit areas: over-exposure control "lowStrength"', byPath(n2l.changes)['ImageOverExposure.ImageOverExposureMode'] === 'lowStrength')
  check('  the night light and white light themselves are never suggested', !n2l.changes.some((c) => /^(illumination|Whitelight)\./.test(c.path)))
  check('N3 infrared off at night and dark: -> auto', byPath(suggest(colourM({ mean: 40 }), withValues(roadway, { InfraredMode: 'off' }), { period: 'night' }).changes).InfraredMode === 'auto')
  check('N4 day/night switch after 2 s: delay -> 10 s (optional)', byPath(suggest(colourM(), roadway, { period: 'day' }).changes).IRCutDelayTime === 10)
  check('  IR-cut mode, sensitivity and anti-flicker are never suggested', !suggest(irGlare, roadway, { period: 'night' }).changes.some((c) => /^(IRCutMode|IRCutConvSen|antiflicker)$/.test(c.path)))
}
{
  const si = (extra) => ({ ...siGate, ...extra, current: { ...siGate.current, ...(extra.current ?? {}) } })
  const box = (streamInfo, stream = { usage: 0.6, bindShare: 0, enough: true, windowS: 30 }, ctx = {}) => suggest(colourM(), pwExitS, { period: 'day', stream, streamInfo, ...ctx }).stream
  const s1 = box(si({ current: { QoI: 4096 }, digitalDefault: 6144 }))
  check('S1 cap below the NVR default -> the default, pre-ticked (South Fence 4096 -> 6144)', s1.find((x) => x.id === 'S1')?.change.QoI === 6144 && s1.find((x) => x.id === 'S1').ticked)
  check('S3 headroom -> quality level +1, not ticked', box(si({}), { usage: 0.3, bindShare: 0, enough: true }).find((x) => x.id === 'S3')?.change.level === 'highest')
  check('S4 H.265+ -> H.265, not ticked, with the encoder restart', box(si({ current: { enct: 'h265p' } })).find((x) => x.id === 'S4')?.encoderRestart === true)
  const h264 = si({ current: { enct: 'h264' } })
  check('S6 H.264 -> H.265 only when this browser can play H.265', !box(h264).some((x) => x.id === 'S6') && box(h264, undefined, { canH265: true }).some((x) => x.id === 'S6' && !x.ticked))
  const drive = si({ current: { res: '2688x1520', QoI: 5120, enct: 'h264' }, qoiList: [2048, 4096, 5120, 6144, 8192, 10240], caps: { ...siGate.caps, resolutions: [{ res: '3840x2160', fps: 20 }, { res: '2688x1520', fps: 20 }] } })
  const s5 = box(drive).find((x) => x.id === 'S5')
  check('S5 only together with a cap scaled by the pixel ratio (Drive Way 5120 x 2.03 -> 10240)', s5?.change.res === '3840x2160' && s5.change.QoI === 10240 && !s5.ticked, JSON.stringify(s5))
  check('  never lowers anything', box(si({}), { usage: 0.99, bindShare: 1, enough: true }).every((x) => x.note || Object.entries(x.change).every(([k, v]) => k === 'enct' || k === 'res' || k === 'level' || v > siGate.current[k])))
  check('not a candidate / ignores its cap / still measuring: a note, no change', box(si({ candidate: false, why: 'the NVR records in manual mode' }))[0].note.includes('manual mode') && box(si({}), { usage: 1.9, bindShare: 1, enough: true })[0].note.includes('does not keep') && box(si({}), { usage: 0.95, bindShare: 1, enough: false, windowS: 8 }).some((x) => x.note && /8 of 20 s/.test(x.note)))
  check('streamChangeOf: one change, the larger cap wins', JSON.stringify(streamChangeOf([{ change: { QoI: 6144 } }, { change: { res: '3840x2160', QoI: 10240 } }, { change: { level: 'highest' } }])) === JSON.stringify({ QoI: 10240, res: '3840x2160', level: 'highest' }))
}
{
  const withFix = { ...colourM(), displayRange: 'full', selfCheck: { range: 'limited' }, coded: { le4: 0.001, le16: 0.05, ge235: 0.02, ge251: 0.01 } }
  const dc = displayCheck(withFix)
  check('display check: the range fix did not take -> clips, and exposure rules see a mismatch', dc.range === 'limited' && dc.clips && dc.mismatch && /clips shadows/.test(dc.text))
  check('  full range shown: no mismatch', !displayCheck({ ...withFix, selfCheck: { range: 'full' } }).mismatch)
  check('  "shows the full range" only with the range fix known to be on', /full range the camera recorded \(range fix on\)/.test(displayCheck({ ...withFix, rangeFixed: true, selfCheck: { range: 'full' } }).text) && displayCheck({ ...withFix, displayRange: 'limited', rangeFixed: false, selfCheck: { range: 'full' } }).text === null)
  const drawn = displayCheck({ ...colourM(), planes: 'rgba', rangeMismatch: null, displayRange: 'full', selfCheck: null })
  check('  a drawn (RGBA) measurement: mismatch assumed, said so', drawn.mismatch === true && /could not be read/.test(drawn.text))
  check('contradiction: black-and-white while the camera reports Day (program auto) -> nothing ticked', /nothing is ticked/.test(contradiction({ mono: true }, gateDay)) && contradiction({ mono: false }, gateDay) === null && contradiction({ mono: true }, pwExitS) === null)
}
{
  const figs = figuresForLog(gate.figures, { stream: gate.stream.looped, rules: { 'sharpen.value': 'P6a' }, refused: { 'whiteBalance.mode': 'kept' }, round: 1 })
  let ok = true
  try {
    notesTest.cleanFigures(figs)
  } catch (e) {
    ok = e.message
  }
  check('figuresForLog: what the panel posts passes the server\'s figures check', ok === true, String(ok))
  check('  mono and rise25 for the camera notes (monoNightAt, focusRef)', figs.mono === false && figs.rise25 === gate.figures.lines.rise25 && figs.usage === 0.961)
  const tagged = figuresForLog({ ...gate.figures, planes: 'rgba', rangeMismatch: null, rangeFixed: true, grab: { complete: false } }, { browser: 'Edge 128' })
  let ok2 = true
  try {
    notesTest.cleanFigures(tagged)
  } catch (e) {
    ok2 = e.message
  }
  check('  and what calibration must tell apart: browser, range fix, planes, grab complete (accepted by the server)', ok2 === true && tagged.browser === 'Edge 128' && tagged.rangeFixed === true && tagged.planes === 'rgba' && tagged.grabComplete === false && tagged.rangeMismatch === null && figs.planes === 'coded', JSON.stringify(tagged).slice(0, 200))
  const { browserLabel } = aa
  check('browserLabel: Edge, Chrome from brands; Firefox and Safari from the user agent', browserLabel({ userAgentData: { brands: [{ brand: 'Not)A;Brand', version: '8' }, { brand: 'Chromium', version: '128' }, { brand: 'Microsoft Edge', version: '128' }] } }) === 'Edge 128' && browserLabel({ userAgentData: { brands: [{ brand: 'Chromium', version: '127' }, { brand: 'Google Chrome', version: '127' }] } }) === 'Chrome 127' && browserLabel({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' }) === 'Firefox 130' && browserLabel({ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15' }) === 'Safari 17' && browserLabel({}) === null)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
