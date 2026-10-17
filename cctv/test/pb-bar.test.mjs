// Offline tests for the playback bar's own rules (public/pb-bar.js): where Previous and Next go,
// the first and the newest recording, the speed slider's stops, the pill on the playhead, the span
// in words and the Playback | Live link; and that both pages (One camera, Many cameras) carry the
// bar's controls with a name and a tooltip each.
//   node cctv/test/pb-bar.test.mjs
import { readFileSync } from 'node:fs'
import {
  JOIN_MS,
  SEQUENCE_TOLERANCE_MS,
  canReverse,
  liveHref,
  pillText,
  readLiveLink,
  recordedSpans,
  recordingEnd,
  recordingStart,
  sequenceStarts,
  sequenceTarget,
  sliderIndex,
  sliderSpeed,
  sliderSpeeds,
  spanStarts,
  spanWords,
  speedText
} from '../public/pb-bar.js'
import { allowedSpeeds } from '../public/pb-transport.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const S = 1000
const MIN = 60 * S
const H = 60 * MIN
// 2026-10-12 00:00:00 UTC
const DAY0 = Date.UTC(2026, 9, 12)

// ---- recorded stretches -----------------------------------------------------------------------
{
  const got = recordedSpans([[3 * H, 4 * H], [1 * H, 2 * H]])
  check('recordedSpans: put in time order', same(got, [{ s: 1 * H, e: 2 * H }, { s: 3 * H, e: 4 * H }]), JSON.stringify(got))
  check('  stretches that touch are one (a file roll-over is not a new recording)', same(recordedSpans([[0, H], [H, 2 * H]]), [{ s: 0, e: 2 * H }]))
  check('  and so are ones a second apart', same(recordedSpans([[0, H], [H + S, 2 * H]]), [{ s: 0, e: 2 * H }]))
  check('  but a real gap keeps them apart', recordedSpans([[0, H], [H + JOIN_MS + 1, 2 * H]]).length === 2)
  check('  one inside another does not shorten it', same(recordedSpans([[0, 3 * H], [H, 2 * H]]), [{ s: 0, e: 3 * H }]))
  check('  the server\'s and the NVR\'s stretches side by side read as one recording', same(recordedSpans([{ s: 0, e: H, src: 'server' }, { s: H, e: 2 * H, src: 'nvr' }]), [{ s: 0, e: 2 * H }]))
  check('  { from, to } and { start, end } are read too', same(recordedSpans([{ from: 0, to: S }, { start: H, end: H + S }]), [{ s: 0, e: S }, { s: H, e: H + S }]))
  check('  reversed, empty and rubbish stretches are dropped', same(recordedSpans([[5, 5], [9, 3], null, {}, ['a', 'b'], [NaN, 4]]), []))
  check('  nothing in, nothing out', same(recordedSpans(null), []) && same(recordedSpans(undefined), []))
  const input = [[0, H], [H, 2 * H]]
  recordedSpans(input)
  check('  the list handed in is left as it was', same(input, [[0, H], [H, 2 * H]]))
  check('spanStarts: where each joined stretch begins', same(spanStarts([[0, H], [H, 2 * H], [5 * H, 6 * H]]), [0, 5 * H]))
}

// ---- previous and next ------------------------------------------------------------------------
{
  const spans = [[1 * H, 2 * H], [4 * H, 5 * H]]
  const marks = [[1 * H + 10 * MIN, 1 * H + 11 * MIN, 'motion'], [4 * H + 30 * MIN, 4 * H + 31 * MIN, 'motion']]
  const starts = sequenceStarts(spans, marks)
  check('sequenceStarts: recording starts and motion starts together, in order', same(starts, [1 * H, 1 * H + 10 * MIN, 4 * H, 4 * H + 30 * MIN]), starts.join(','))
  check('  a mark that starts with its recording is one stop, not two', same(sequenceStarts([[H, 2 * H]], [[H, H + S]]), [H]))
  check('  bare times and { start } marks count (search hits)', same(sequenceStarts([], [5, { start: 9 }, { s: 7 }]), [5, 7, 9]))
  check('  rubbish marks are skipped', same(sequenceStarts([], [null, {}, 'x', [NaN]]), []))

  const next = (atMs, extra = {}) => sequenceTarget({ spans, marks, atMs, direction: 1, ...extra })
  const prev = (atMs, extra = {}) => sequenceTarget({ spans, marks, atMs, direction: -1, ...extra })
  check('next: the first start after the playhead', next(1 * H + 5 * MIN) === 1 * H + 10 * MIN)
  check('  across a gap, the start of the next recording', next(2 * H + 30 * MIN) === 4 * H)
  check('  from before everything, the first recording', next(0) === 1 * H)
  check('  standing on a mark, the one after it (never the one it is on)', next(1 * H + 10 * MIN) === 4 * H && next(1 * H + 10 * MIN + S) === 4 * H)
  check('  a mark just ahead, inside the tolerance, counts as the one it is on', next(1 * H + 10 * MIN - S) === 4 * H)
  check('  after the last one there is nothing: null, so the page can say so', next(4 * H + 30 * MIN) === null && next(23 * H) === null)

  check('previous: the nearest start before the playhead', prev(1 * H + 50 * MIN) === 1 * H + 10 * MIN)
  check('  in a gap, the last start before it', prev(3 * H) === 1 * H + 10 * MIN)
  check('  a second after jumping to a mark, the one before it (pressing twice walks back)', prev(1 * H + 10 * MIN + S) === 1 * H)
  check('  exactly on a mark, the one before it', prev(4 * H) === 1 * H + 10 * MIN)
  check('  once it has played on past the tolerance, back to that mark\'s own start', prev(1 * H + 10 * MIN + SEQUENCE_TOLERANCE_MS + 1) === 1 * H + 10 * MIN)
  check('  before the first one there is nothing: null', prev(1 * H) === null && prev(1 * H + S) === null && prev(0) === null)
  // walking: each press lands on a start, and the next press (a second later) goes one further
  const walked = []
  for (let at = 5 * H; at !== null && walked.length < 10; ) {
    at = prev(at + S)
    if (at !== null) walked.push(at)
  }
  check('  walking back from the end visits every start once and then stops', same(walked, [4 * H + 30 * MIN, 4 * H, 1 * H + 10 * MIN, 1 * H]), walked.join(','))

  check('a wider tolerance (playing fast) skips the mark the playhead has run on from', prev(1 * H + 10 * MIN + 10 * S, { toleranceMs: 8 * SEQUENCE_TOLERANCE_MS }) === 1 * H)
  check('  a tolerance of nothing is exact', prev(1 * H + 10 * MIN + 1, { toleranceMs: 0 }) === 1 * H + 10 * MIN && next(1 * H + 10 * MIN - 1, { toleranceMs: 0 }) === 1 * H + 10 * MIN)
  check('  a rubbish tolerance falls back to the usual one', prev(1 * H + 10 * MIN + S, { toleranceMs: NaN }) === 1 * H)
  check('no playhead, no target', sequenceTarget({ spans, marks, atMs: null, direction: 1 }) === null && sequenceTarget({ spans, marks, atMs: NaN, direction: -1 }) === null)
  check('nothing recorded and no marks: null both ways', sequenceTarget({ spans: [], marks: [], atMs: H, direction: 1 }) === null && sequenceTarget({ atMs: H, direction: -1 }) === null)
  check('with no arguments at all it answers null rather than throwing', sequenceTarget() === null)

  // Many cameras: each camera's own starts are the marks (wall.js jumpSequence)
  const camA = [{ s: 1 * H, e: 3 * H }]
  const camB = [{ s: 2 * H, e: 2 * H + 30 * MIN }, { s: 2 * H + 30 * MIN, e: 4 * H }]
  const wallMarks = [camA, camB].flatMap((c) => spanStarts(c))
  check('several cameras: a camera starting while another records is still a stop', sequenceTarget({ spans: [], marks: wallMarks, atMs: 1 * H + 30 * MIN, direction: 1 }) === 2 * H)
  check('  and a file roll-over on one of them is not', sequenceTarget({ spans: [], marks: wallMarks, atMs: 2 * H + 10 * MIN, direction: 1 }) === null)
}

// ---- the first and the newest recording -------------------------------------------------------
{
  const spans = [[4 * H, 5 * H], [1 * H, 2 * H]]
  check('recordingStart: the start of the earliest recording, whatever order they came in', recordingStart(spans) === 1 * H)
  check('  nothing recorded: null', recordingStart([]) === null && recordingStart(null) === null)
  check('recordingEnd: a little before the end of the newest recording', recordingEnd(spans) === 5 * H - 10 * S)
  check('  how far back is the caller\'s to say (today: where the page opens)', recordingEnd(spans, { backMs: 5 * MIN }) === 5 * H - 5 * MIN)
  check('  never before that recording began', recordingEnd([[H, H + 3 * S]], { backMs: 60 * S }) === H)
  check('  joined files count as one recording when stepping back from the end', recordingEnd([[H, H + 30 * S], [H + 30 * S, H + 40 * S]], { backMs: 20 * S }) === H + 20 * S)
  check('  a negative step back is no step', recordingEnd(spans, { backMs: -5 }) === 5 * H)
  check('  nothing recorded: null', recordingEnd([]) === null)
}

// ---- the speed slider -------------------------------------------------------------------------
{
  const server = allowedSpeeds('server')
  const nvr = allowedSpeeds('nvr')
  check('sliderSpeeds: the forward speeds of the source, slowest first', same(sliderSpeeds(nvr), [1, 2, 4, 8]) && same(sliderSpeeds(server), [1, 2, 4, 8, 16, 32]), `${sliderSpeeds(nvr)} | ${sliderSpeeds(server)}`)
  check('  exactly what the old Speed button stepped through', same(sliderSpeeds(server), server.filter((x) => x >= 1)) && same(sliderSpeeds(nvr), nvr.filter((x) => x >= 1)))
  check('  nothing allowed: no stops', same(sliderSpeeds([]), []) && same(sliderSpeeds(null), []))
  for (const [name, allowed] of [['server', server], ['nvr', nvr]]) {
    const stops = sliderSpeeds(allowed)
    check(`every stop is a speed the ${name} source plays`, stops.every((_, i) => allowed.includes(sliderSpeed(i, allowed))))
    check(`  and each speed comes back to its own stop (${name})`, stops.every((s, i) => sliderIndex(s, allowed) === i && sliderSpeed(i, allowed) === s))
  }
  check('sliderSpeed: a stop between two snaps to the nearer', sliderSpeed(1.4, nvr) === 2 && sliderSpeed(1.6, nvr) === 4)
  check('  past either end stays on the slider', sliderSpeed(-3, nvr) === 1 && sliderSpeed(99, nvr) === 8 && sliderSpeed(99, server) === 32)
  check('  rubbish is the slowest', sliderSpeed(NaN, nvr) === 1 && sliderSpeed(undefined, server) === 1)
  check('  no stops at all: normal speed', sliderSpeed(2, []) === 1)
  check('  playing backwards keeps going backwards, at the stop chosen', sliderSpeed(2, server, -1) === -4 && sliderSpeed(0, server, -1) === -1)
  check('  a source that cannot reverse is never handed a reverse speed', sliderSpeed(2, nvr, -1) === 4 && allowedSpeeds('nvr').includes(sliderSpeed(3, nvr, -1)))
  check('sliderIndex: a reverse speed shows at its own size', sliderIndex(-4, server) === 2 && sliderIndex(-32, server) === 5)
  check('  a speed the source lacks shows at the stop below it', sliderIndex(16, nvr) === 3 && sliderIndex(3, nvr) === 1)
  check('  nothing or rubbish shows as normal speed', sliderIndex(0, nvr) === 0 && sliderIndex(NaN, server) === 0 && sliderIndex(undefined, nvr) === 0)
  check('canReverse: the server\'s recordings can, the NVR\'s playback cannot', canReverse(server) === true && canReverse(nvr) === false && canReverse(null) === false)
  check('speedText: forwards', speedText(1) === '1×' && speedText(16) === '16×')
  check('  backwards says so in a word', speedText(-4) === '4× back')
  check('  rubbish reads as normal speed', speedText(0) === '1×' && speedText(NaN) === '1×')
}

// ---- the pill ---------------------------------------------------------------------------------
{
  const t = DAY0 + 9 * H + 34 * MIN + 48 * S + 199
  check('pillText: the date and the time to the second', pillText(t) === '2026-10-12 09:34:48', pillText(t))
  check('  milliseconds only when asked for', pillText(t, { millis: true }) === '2026-10-12 09:34:48.199', pillText(t, { millis: true }))
  check('  on the site\'s clock, not the browser\'s: an offset moves the time', pillText(t, { tzOffsetMs: -4 * H }) === '2026-10-12 05:34:48', pillText(t, { tzOffsetMs: -4 * H }))
  check('  and the date with it, over midnight either way', pillText(DAY0 + 30 * MIN, { tzOffsetMs: -4 * H }) === '2026-10-11 20:30:00' && pillText(DAY0 + 23 * H, { tzOffsetMs: 2 * H }) === '2026-10-13 01:00:00')
  check('  a half-hour zone is honoured', pillText(DAY0, { tzOffsetMs: 5.5 * H }) === '2026-10-12 05:30:00')
  check('  no playhead: empty, never a made-up time', pillText(null) === '' && pillText(NaN) === '' && pillText(undefined) === '')
  check('  a rubbish offset is no offset', pillText(t, { tzOffsetMs: NaN }) === '2026-10-12 09:34:48')
  const before = process.env.TZ
  process.env.TZ = 'Pacific/Auckland'
  check('  the machine\'s own zone has no say', pillText(t) === '2026-10-12 09:34:48', pillText(t))
  if (before === undefined) delete process.env.TZ
  else process.env.TZ = before
}

// ---- the span in words ------------------------------------------------------------------------
{
  check('spanWords: the four presets', spanWords(24 * H) === '24 hours' && spanWords(H) === '1 hour' && spanWords(10 * MIN) === '10 minutes' && spanWords(MIN) === '1 minute', [24 * H, H, 10 * MIN, MIN].map(spanWords).join(' | '))
  check('  five minutes, two hours, thirty seconds', spanWords(5 * MIN) === '5 minutes' && spanWords(2 * H) === '2 hours' && spanWords(30 * S) === '30 seconds')
  check('  one of anything is singular', spanWords(S) === '1 second' && spanWords(MIN) === '1 minute' && spanWords(H) === '1 hour')
  check('  an awkward span is rounded to a tenth', spanWords(90 * MIN) === '1.5 hours' && spanWords(91 * S) === '1.5 minutes' && spanWords(12_345) === '12.3 seconds', [90 * MIN, 91 * S, 12_345].map(spanWords).join(' | '))
  check('  just under a unit is said in that unit, never "60 minutes"', spanWords(3599 * S) === '1 hour' && spanWords(59_990) === '1 minute', `${spanWords(3599 * S)} | ${spanWords(59_990)}`)
  check('  nothing, a negative or rubbish is no time at all', spanWords(0) === '0 seconds' && spanWords(-5) === '0 seconds' && spanWords(NaN) === '0 seconds')
}

// ---- Playback | Live --------------------------------------------------------------------------
{
  check('liveHref: one camera opens it on the Live page', liveHref({ nvr: 'nvr1', ch: 0 }) === '/?nvr=nvr1&ch=0', liveHref({ nvr: 'nvr1', ch: 0 }))
  check('  an NVR id with odd characters is escaped', liveHref({ nvr: 'a b&c', ch: 3 }) === '/?nvr=a%20b%26c&ch=3')
  check('  a saved view goes by its id', liveHref({ view: 'v1abc', cameras: ['nvr1/0'] }) === '/?view=v1abc')
  check('  cameras picked by hand go as a list', liveHref({ cameras: ['nvr1/0', 'nvr-2/11'] }) === '/?cameras=nvr1%2F0,nvr-2%2F11', liveHref({ cameras: ['nvr1/0', 'nvr-2/11'] }))
  check('  nothing to show: plain Live', liveHref() === '/' && liveHref({ cameras: [] }) === '/' && liveHref({ nvr: null, ch: null }) === '/' && liveHref({ nvr: 'nvr1' }) === '/')
  check('  rubbish in the list is left out', liveHref({ cameras: [null, 7, 'nokey', 'nvr1/2'] }) === '/?cameras=nvr1%2F2')

  const back = (href) => readLiveLink(href.slice(href.indexOf('?')))
  check('readLiveLink: reads back one camera', same(back(liveHref({ nvr: 'nvr1', ch: 0 })), { camera: { nvr: 'nvr1', ch: '0' }, view: null, cameras: null }), JSON.stringify(back(liveHref({ nvr: 'nvr1', ch: 0 }))))
  check('  and an escaped id', back(liveHref({ nvr: 'a b&c', ch: 3 })).camera.nvr === 'a b&c')
  check('  a view', same(back(liveHref({ view: 'v1abc' })), { camera: null, view: 'v1abc', cameras: null }))
  check('  a list of cameras, in order', same(back(liveHref({ cameras: ['nvr1/0', 'nvr-2/11'] })).cameras, ['nvr1/0', 'nvr-2/11']))
  check('  the plain address asks for nothing', same(readLiveLink(''), { camera: null, view: null, cameras: null }) && same(readLiveLink(undefined), { camera: null, view: null, cameras: null }))
  check('  half a camera is no camera', readLiveLink('?nvr=nvr1').camera === null && readLiveLink('?ch=2').camera === null)
  check('  the Live page\'s other switches are not mistaken for a link', same(readLiveLink('?stats=1&pacing=off'), { camera: null, view: null, cameras: null }))
}

// ---- the pages that carry the bar -------------------------------------------------------------
{
  const src = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8')
  const pbHtml = src('playback.html')
  const wallHtml = src('wall.html')
  const pb = src('playback.js')
  const wall = src('wall.js')
  const viewer = src('viewer.js')
  const css = src('style.css')
  const tagOf = (html, id) => new RegExp(`<(?:button|input|a)\\b[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0] ?? ''
  const named = (html, id) => /\baria-label="[^"]+"/.test(tagOf(html, id)) || /^<a\b/.test(tagOf(html, id))
  const tipped = (html, id) => /\btitle="[^"]+"/.test(tagOf(html, id))
  const order = (html, ids) => ids.map((id) => html.indexOf(`id="${id}"`))
  const rising = (list) => list.every((n, i) => n >= 0 && (i === 0 || n > list[i - 1]))

  const pbRow = ['toStart', 'seqPrev', 'framePrev', 'playBack', 'speedSlider', 'play', 'frameNext', 'seqNext', 'toEnd']
  check('One camera: the transport row is in the order start, previous, frame back, backwards, speed, play, frame on, next, end', rising(order(pbHtml, pbRow)), order(pbHtml, pbRow).join(','))
  check('  every one of them has a name and a tooltip', pbRow.every((id) => named(pbHtml, id) && tipped(pbHtml, id)), pbRow.filter((id) => !named(pbHtml, id) || !tipped(pbHtml, id)).join(','))
  check('  Play backwards starts hidden: the page shows it only where the footage can be played backwards', /\bhidden\b/.test(tagOf(pbHtml, 'playBack')) && /playBackBtn\.hidden = !reverseOffered\(\)/.test(pb) && /canReverse\(allowedSpeeds\(state\.mode\)\)/.test(pb))
  check('  the 30-second jumps are still there, and say they are jumps', ['back', 'fwd'].every((id) => /Jump (back|forward) 30 seconds/.test(tagOf(pbHtml, id))))
  const tools = ['bookmark', 'snapshot', 'selectClip', 'exportClip', 'moreBtn', 'fullscreen']
  check('  the tools follow the transport, all of them', rising(order(pbHtml, ['toEnd', ...tools])), order(pbHtml, tools).join(','))
  check('  nothing the old bar had is gone', ['dayPrev', 'dayNext', 'clock', 'clockInput', 'followBtn', 'overview', 'timeline', 'speeds', 'shuttle', 'searchToggle', 'quality', 'shortcutsBtn', 'follow'].every((id) => pbHtml.includes(`id="${id}"`)))
  check('  the ruler and its pill sit above the tracks, the switch and the span under them', rising(order(pbHtml, ['ruler', 'ticks', 'pill', 'timeline', 'followBtn', 'liveLink', 'spanLabel'])))
  check('  the four spans are still one click each', [86400000, 3600000, 600000, 60000].every((ms) => new RegExp(`<button type="button" data-span="${ms}"`).test(pbHtml)))
  check('  Live is a link, and Playback is marked as where you are', /^<a\b/.test(tagOf(pbHtml, 'liveLink')) && tipped(pbHtml, 'liveLink') && /aria-current="page"[^>]*>Playback</.test(pbHtml))
  check('  the page takes its rules from pb-bar.js rather than repeating them', /from '\.\/pb-bar\.js'/.test(pb) && /sequenceTarget\(/.test(pb) && /pillText\(state\.position, \{ tzOffsetMs: state\.tz/.test(pb) && /spanWords\(v\.spanMs\)/.test(pb) && /liveHref\(\{ nvr: state\.nvr, ch: state\.ch \}\)/.test(pb))
  check('  the slider only ever sets a speed the source allows', /setSpeed\(sliderSpeed\(Number\(speedSlider\.value\), allowedSpeeds\(state\.mode\)/.test(pb))
  check('  Follow is still its own button, not the Live switch', /followBtn\.addEventListener\('click', \(\) => setFollow\(!state\.follow\)\)/.test(pb))
  check('  the new keys are wired and listed (Home, End, R, < >)', /e\.key === 'Home' \|\| e\.key === 'End'/.test(pb) && /e\.key === 'r' \|\| e\.key === 'R'/.test(pb) && /e\.key === '<' \|\| e\.key === '>'/.test(pb) && /<dt>Home End<\/dt>/.test(pbHtml) && /<dt>R<\/dt>/.test(pbHtml))
  check('  and the old ones are all still there', [`e.key === ' '`, `e.key === 'ArrowLeft'`, `e.key === 'ArrowRight'`, `e.key === ','`, `e.key === '.'`, `e.key === '0'`, `e.key === '['`, `e.key === ']'`, `e.key === '?'`, `e.key === 't' || e.key === 'T'`, `e.key === 'b' || e.key === 'B'`, `e.key === 'f' || e.key === 'F'`, `e.key === 'd' || e.key === 'D'`].every((k) => pb.includes(k)))

  const wallRow = ['toStart', 'seqPrev', 'speedSlider', 'play', 'seqNext', 'toEnd']
  check('Many cameras: the same row, without what the wall cannot do', rising(order(wallHtml, wallRow)), order(wallHtml, wallRow).join(','))
  check('  every one of them has a name and a tooltip', wallRow.every((id) => named(wallHtml, id) && tipped(wallHtml, id)))
  check('  no frame step and no play backwards are offered there', !/id="(framePrev|frameNext|playBack)"/.test(wallHtml))
  check('  the jumps, the tools and the old controls are all still there', ['back', 'fwd', 'exportView', 'moreBtn', 'dayPrev', 'dayNext', 'clock', 'followBtn', 'coverage', 'speeds', 'laneMode', 'shuttle'].every((id) => wallHtml.includes(`id="${id}"`)))
  check('  the ruler and its pill sit above the lanes, the switch and the span under them', rising(order(wallHtml, ['ruler', 'ticks', 'pill', 'lanes', 'followBtn', 'liveLink', 'spanLabel'])))
  check('  the wall uses the same rules', /from '\.\/pb-bar\.js'/.test(wall) && /sequenceTarget\(/.test(wall) && /pillText\(at, \{ tzOffsetMs: state\.tz \}\)/.test(wall) && /spanWords\(v\.spanMs\)/.test(wall))
  check('  and its Live link carries the saved view or the cameras on the wall', /liveHref\(\{ view: state\.viewId \|\| null, cameras: state\.cameras \}\)/.test(wall))

  check('the Live page reads the link', /import \{ readLiveLink \} from '\.\/pb-bar\.js'/.test(viewer) && /readLiveLink\(location\.search\)/.test(viewer) && /openSingle\(cam\)/.test(viewer))
  check('  last of all, and inside a try: a bad link never stops the Live page', /try \{\s*const link = readLiveLink\(location\.search\)[\s\S]*\} catch \(e\) \{\s*console\.error\('\[live\] link', e\)\s*\}\s*$/.test(viewer))
  check('the style sheet draws the pill, the ruler and the switch', ['.pb-pill', '.pb-ruler', '.pb-ruler-head', '.pb-live-switch', '.pb-speed-slider', '.pb-under'].every((c) => css.includes(`${c} `) || css.includes(`${c}{`)))
  check('  the pill is kept inside the ruler by the style sheet', /\.pb-pill \{[^}]*left: clamp\(var\(--pill-half\), var\(--at, 50%\), calc\(100% - var\(--pill-half\)\)\)/.test(css))
}

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
// (exitCode, not process.exit(): on the CI runner an exit while the output is still being written hangs)
process.exitCode = failures === 0 ? 0 : 1
