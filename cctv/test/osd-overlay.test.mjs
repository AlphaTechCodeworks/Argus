// Offline tests for the on-screen display this app draws over the picture (public/osd-overlay.js):
// where the text lands and how it is clamped, text too long for the tile, a camera with no name,
// the same settings scaled from a phone tile to a 4K one, the settings validation, and the wiring
// in the pages that draw it. Pure JavaScript: no NVR, no SDK, no network, no DOM, no data folder,
// so it runs on Windows exactly as it runs in the container.
//   node cctv/test/osd-overlay.test.mjs
import { readFileSync } from 'node:fs'

const {
  DEFAULT_OSD,
  DEFAULT_SIZE,
  ELLIPSIS,
  MAX_SIZE,
  MAX_TEXT,
  MIN_FONT_PX,
  OSD_CORNERS,
  cleanOsdSettings,
  clockOffsetFrom,
  cornerOf,
  drawOsd,
  estimateWidth,
  fitText,
  osdFont,
  osdFontPx,
  osdFor,
  osdIsOff,
  osdLayout,
  osdLines,
  osdPositionFrom,
  osdTimeText
} = await import('../public/osd-overlay.js')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const threw = (fn) => {
  try {
    fn()
    return null
  } catch (e) {
    return e
  }
}
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

// A fixed moment used throughout, written out in UTC so the test says the same thing on any machine.
const AT = Date.parse('2026-09-25T14:03:12Z')
const cam = { name: 'Yard — north gate' }
const settings = (patch = {}) => cleanOsdSettings(patch)
const lay = (patch, size = {}) =>
  osdLayout({ settings: settings(patch), camera: size.camera ?? cam, atMs: AT, width: size.width ?? 1920, height: size.height ?? 1080, tzMs: 0 })
const right = (l) => l.box.x + l.box.w
const bottom = (l) => l.box.y + l.box.h

// ---- the settings ------------------------------------------------------------------------------
{
  check('the built-in default shows both the name and the time', DEFAULT_OSD.showName === true && DEFAULT_OSD.showTime === true)
  check('  and sits inside the picture, not on its very edge', DEFAULT_OSD.x > 0 && DEFAULT_OSD.x < 1 && DEFAULT_OSD.y > 0 && DEFAULT_OSD.y < 1)
  check('  with no text of its own, so each camera shows its own name', DEFAULT_OSD.text === null)
  check('nothing given means the built-in default, complete', JSON.stringify(cleanOsdSettings(null)) === JSON.stringify(DEFAULT_OSD))
  check('a missing field is filled in rather than left undefined', cleanOsdSettings({ showTime: false }).size === DEFAULT_SIZE)
  check('a camera falls back to the site default, not to the built-in one', osdFor({ size: 6 }, { showTime: false }).size === 6)
  check('  and its own value still wins', osdFor({ size: 6 }, { size: 2 }).size === 2)

  check('a value that is not an object is refused', Boolean(threw(() => cleanOsdSettings('top-left'))))
  check('an array is refused (it would silently keep none of the fields)', Boolean(threw(() => cleanOsdSettings([]))))
  check('an unknown field is refused', /unknown field/.test(threw(() => cleanOsdSettings({ colour: 'red' }))?.message ?? ''))
  check('showName must be a flag', /true or false/.test(threw(() => cleanOsdSettings({ showName: 'yes' }))?.message ?? ''))
  check('x outside 0-1 is refused', /between 0 and 1/.test(threw(() => cleanOsdSettings({ x: 1.4 }))?.message ?? ''))
  check('  and a negative y too', Boolean(threw(() => cleanOsdSettings({ y: -0.01 }))))
  check('  0 and 1 themselves are allowed (they are clamped when drawn, not refused here)', cleanOsdSettings({ x: 0, y: 1 }).x === 0)
  check('x that is not a number is refused', /must be a number/.test(threw(() => cleanOsdSettings({ x: 'left' }))?.message ?? ''))
  check('  including NaN, which would otherwise slip through a typeof check', Boolean(threw(() => cleanOsdSettings({ x: Number.NaN }))))
  check(`a size above ${MAX_SIZE} % is refused`, /between/.test(threw(() => cleanOsdSettings({ size: MAX_SIZE + 0.1 }))?.message ?? ''))
  check('  and below the minimum', Boolean(threw(() => cleanOsdSettings({ size: 0 }))))
  check(`text longer than ${MAX_TEXT} characters is refused`, /longer than/.test(threw(() => cleanOsdSettings({ text: 'x'.repeat(MAX_TEXT + 1) }))?.message ?? ''))
  check(`  exactly ${MAX_TEXT} is fine`, cleanOsdSettings({ text: 'x'.repeat(MAX_TEXT) }).text.length === MAX_TEXT)
  check('text is tidied (a newline would break the line the layout counts on)', cleanOsdSettings({ text: '  Yard \n gate ' }).text === 'Yard gate')
  check('empty text means the camera’s own name, not a blank line', cleanOsdSettings({ text: '   ' }).text === null)
  check('text that is not a string is refused', Boolean(threw(() => cleanOsdSettings({ text: 42 }))))
  check('both switched off is "nothing to draw"', osdIsOff(cleanOsdSettings({ showName: false, showTime: false })) && !osdIsOff(DEFAULT_OSD))
}

// ---- the lines ---------------------------------------------------------------------------------
{
  check('name and time, name first', osdLines(settings(), cam, AT, 0).join(' | ') === 'Yard — north gate | 2026-09-25 14:03:12')
  check('the time alone when the name is switched off', osdLines(settings({ showName: false }), cam, AT, 0).join() === '2026-09-25 14:03:12')
  check('the chosen text replaces the camera’s name', osdLines(settings({ text: 'Front door' }), cam, AT, 0)[0] === 'Front door')

  // Never invent data: a camera whose name we do not know shows NO name, not "Camera" or "Unknown".
  check('a camera with no name shows no name line at all', osdLines(settings(), {}, AT, 0).join() === '2026-09-25 14:03:12')
  check('  nor a blank name', osdLines(settings(), { name: '   ' }, AT, 0).length === 1)
  check('  and nothing invented is drawn in its place', !osdLines(settings(), {}, AT, 0).join(' ').match(/camera|unknown|n\/a/i))
  check('  but a chosen text still shows for a nameless camera', osdLines(settings({ text: 'Bay 4' }), {}, AT, 0)[0] === 'Bay 4')
  check('no moment yet means no time line, not "Invalid Date"', osdLines(settings(), cam, null, 0).join() === 'Yard — north gate')
  check('nothing switched on gives no lines', osdLines(settings({ showName: false, showTime: false }), cam, AT, 0).length === 0)

  check('the time is written the way the rest of the app writes it', osdTimeText(AT, 0) === '2026-09-25 14:03:12')
  check('  in the time zone it is given, not the machine’s', osdTimeText(AT, 3600_000) === '2026-09-25 15:03:12')
  check('  over midnight the date follows too', osdTimeText(Date.parse('2026-09-25T23:30:00Z'), 3600_000) === '2026-09-26 00:30:00')
  check('a moment that is not a number gives nothing', osdTimeText(Number.NaN) === null && osdTimeText(undefined) === null)
}

// ---- position and clamping ---------------------------------------------------------------------
{
  const tl = lay({ x: 0.02, y: 0.03 })
  check('top left: the block starts near the top left', tl.box.x > 0 && tl.box.x < 100 && tl.box.y > 0 && tl.box.y < 100)
  check('  and the text is left-aligned, so it grows to the right', tl.lines.every((l) => l.align === 'left'))
  check('  the lines are stacked, second under first', tl.lines[1].y > tl.lines[0].y && Math.abs(tl.lines[1].y - tl.lines[0].y - tl.lineHeight) < 0.001)

  const br = lay({ x: 0.98, y: 0.97 })
  check('bottom right: the block ends near the bottom right', right(br) > 1800 && bottom(br) > 1000)
  check('  and grows leftwards and upwards from its corner', br.lines.every((l) => l.align === 'right') && br.box.y < 1080 - br.box.h)

  const c = lay({ x: 0.5, y: 0.5 })
  check('centre: the block is centred across the picture', c.lines.every((l) => l.align === 'centre') && Math.abs(c.box.x + c.box.w / 2 - 960) < 2)

  // The clamp is the whole safety net: whatever the stored figures say, nothing may leave the tile.
  for (const [x, y] of [[0, 0], [1, 1], [1, 0], [0, 1], [0.999, 0.999]]) {
    const l = lay({ x, y })
    const inside = l.box.x >= 0 && l.box.y >= 0 && right(l) <= 1920 && bottom(l) <= 1080
    check(`x=${x} y=${y} is clamped inside the picture`, inside, `${Math.round(l.box.x)},${Math.round(l.box.y)} ${Math.round(right(l))}x${Math.round(bottom(l))}`)
    check('  with a margin, never hard against the edge', l.box.x >= l.pad && l.box.y >= l.pad)
  }

  const corners = OSD_CORNERS.map((k) => lay({ x: k.x, y: k.y }))
  check('every offered corner lands inside the picture', corners.every((l) => l.box.x >= 0 && right(l) <= 1920 && l.box.y >= 0 && bottom(l) <= 1080))
  check('the nine corners are nine different places', new Set(corners.map((l) => `${Math.round(l.box.x)},${Math.round(l.box.y)}`)).size === 9)
  check('a corner is recognised again from its x/y', cornerOf({ x: OSD_CORNERS[8].x, y: OSD_CORNERS[8].y }) === 'bottom-right')
  check('  and a nudged position belongs to no corner', cornerOf({ x: 0.4, y: 0.11 }) === null)

  check('a pointer at the middle of the picture is the middle of the picture', JSON.stringify(osdPositionFrom(960, 540, 1920, 1080)) === '{"x":0.5,"y":0.5}')
  check('  and a pointer dragged off the edge is clamped, not stored as 1.4', osdPositionFrom(3000, -40, 1920, 1080).x === 1 && osdPositionFrom(3000, -40, 1920, 1080).y === 0)
}

// ---- text too long for the tile -------------------------------------------------------------------
{
  const long = 'Yard north gate by the bin store' // 34, within MAX_TEXT
  check('a line that fits is left exactly as it is', fitText('Yard', 500, 20) === 'Yard')
  const cut = fitText(long, 120, 20)
  check('a line too long is cut and marked with an ellipsis', cut.endsWith(ELLIPSIS) && cut.length < long.length)
  check('  the cut line really does fit', estimateWidth(cut, 20) <= 120)
  check('  the start is kept, because that is where a camera name carries its meaning', cut.startsWith('Yard'))
  check('  nothing sensible fits at all: an empty line, not a lone ellipsis pretending to be text', fitText(long, 3, 20) === '')

  // The whole layout on a narrow tile: the block must still be inside it, even right-aligned.
  const narrow = osdLayout({ settings: settings({ text: long, x: 0.98, y: 0.03 }), camera: cam, atMs: AT, width: 220, height: 124, tzMs: 0 })
  check('on a tile too narrow for the name, the block still fits the tile', narrow.box.x >= 0 && right(narrow) <= 220, `${Math.round(narrow.box.x)}+${Math.round(narrow.box.w)}`)
  check('  and every line is cut, not run off the side', narrow.lines.every((l) => estimateWidth(l.text, narrow.fontPx) <= 220))
  check('  the name is still recognisable at the start', narrow.lines[0].text.startsWith('Yard'))
  const tiny = osdLayout({ settings: settings({ text: long }), camera: cam, atMs: AT, width: 8, height: 60, tzMs: 0 })
  check('a tile narrower than its own margins draws nothing rather than negative widths', tiny.lines.length === 0 && tiny.box === null)
}

// ---- scaling, from a phone tile to a 4K one --------------------------------------------------------
{
  const s = settings({ x: 0.02, y: 0.03, size: 4 })
  const phone = osdLayout({ settings: s, camera: cam, atMs: AT, width: 360, height: 203, tzMs: 0 })
  const hd = osdLayout({ settings: s, camera: cam, atMs: AT, width: 1920, height: 1080, tzMs: 0 })
  const uhd = osdLayout({ settings: s, camera: cam, atMs: AT, width: 3840, height: 2160, tzMs: 0 })

  check('the font grows with the tile', phone.fontPx < hd.fontPx && hd.fontPx < uhd.fontPx, `${phone.fontPx} / ${hd.fontPx} / ${uhd.fontPx}`)
  check('  4K is about twice 1080p, because the size is a share of the height', Math.abs(uhd.fontPx / hd.fontPx - 2) < 0.05)
  check('  and the text sits at the same place in the picture at every size',
    Math.abs(hd.box.x / 1920 - uhd.box.x / 3840) < 0.005 && Math.abs(hd.box.y / 1080 - uhd.box.y / 2160) < 0.005)

  // The floor: a phone tile in an 8x8 grid would otherwise get two-pixel text nobody can read.
  const speck = osdLayout({ settings: settings({ size: 4 }), camera: cam, atMs: AT, width: 120, height: 68, tzMs: 0 })
  check(`a very small tile stops at the ${MIN_FONT_PX} px floor rather than scaling into nothing`, speck.fontPx === MIN_FONT_PX, String(speck.fontPx))
  check('  and the block is still inside that tiny tile', speck.box.x >= 0 && bottom(speck) <= 68)
  check('the ceiling holds too: two lines never swallow the picture', osdFontPx(MAX_SIZE, 300) <= 300 / 6 + 1, String(osdFontPx(MAX_SIZE, 300)))
  check('a height of zero does not divide by zero or return NaN', Number.isFinite(osdFontPx(4, 0)))
}

// ---- painting ---------------------------------------------------------------------------------------
{
  // A stand-in for a 2D context: enough to record what would be painted.
  const calls = []
  const ctx = {
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    strokeText: (t) => calls.push(`stroke:${t}`),
    fillText: (t) => calls.push(`fill:${t}`),
    measureText: (t) => ({ width: t.length * 8 })
  }
  drawOsd(ctx, lay({}))
  check('each line is outlined and then filled, so it reads over a bright yard and a dark car park',
    calls.filter((c) => c.startsWith('stroke:')).length === 2 && calls.filter((c) => c.startsWith('fill:')).length === 2)
  check('  the context is left as it was found', calls[0] === 'save' && calls.at(-1) === 'restore')
  check('nothing to draw paints nothing at all', (() => { const c = []; drawOsd({ save: () => c.push('x') }, { lines: [] }); return c.length === 0 })())
  check('no context at all is survived (a tile torn down mid-paint)', threw(() => drawOsd(null, lay({}))) === null)
  check('the font string carries the size it was given', osdFont(17).includes('17px'))

  const measured = osdLayout({ settings: settings(), camera: cam, atMs: AT, width: 1920, height: 1080, tzMs: 0, measure: (t, f) => t.length * f })
  check('a real measurer is used instead of the estimate', measured.box.w > lay({}).box.w)
}

// ---- the server's clock ------------------------------------------------------------------------------
{
  check('a Date header ahead of this browser gives a positive offset', clockOffsetFrom('Fri, 25 Sep 2026 14:03:12 GMT', Date.parse('2026-09-25T14:03:02Z')) === 10_000)
  check('  and behind it, a negative one', clockOffsetFrom(Date.parse('2026-09-25T14:03:02Z'), Date.parse('2026-09-25T14:03:12Z')) === -10_000)
  check('no header at all: the caller keeps what it had', clockOffsetFrom(null) === null && clockOffsetFrom(undefined) === null)
  check('an unreadable header is ignored rather than turned into NaN', clockOffsetFrom('not a date') === null)
  check('a difference of years is a broken clock, not a skew worth following', clockOffsetFrom('Fri, 25 Sep 2000 14:03:12 GMT', AT) === null)
}

// ---- the storage and the API (camera-notes.mjs, read as text: it needs a data folder to run) ----------
{
  const notes = src('../camera-notes.mjs')
  check('the overlay settings live with the other per-camera app data', /osd/.test(notes) && /camera-notes\.json/.test(notes))
  check('  and reuse this module’s validation rather than a second copy of the rules', /from '\.\/public\/osd-overlay\.js'/.test(notes) && /cleanOsdSettings/.test(notes))
  check('there is a read route every signed-in page can use', /OSD_PATH = '\/api\/osd'/.test(notes))
  check('  and an admin-only write route', /ADMIN_OSD_PATH = '\/api\/admin\/osd'/.test(notes))
  check('a write by someone who is not an admin is refused', /if \(!ctx\.admin\) return \[403/.test(notes))
  check('a camera key must be "<nvr>/<channel>"', /OSD_KEY_RE/.test(notes))
  check('setting a camera to null puts it back on the default', /patch\[key\] = null/.test(notes))
  check('the read is never cached, so a change reaches the next page load', /'cache-control': 'no-store'/.test(notes))
  check('it says in the file that nothing here is ever sent to a camera or an NVR', /never sent|nothing here is ever sent/i.test(notes))
}

// ---- the pages that draw it ---------------------------------------------------------------------------
{
  const tile = src('../public/live-tile.js')
  const viewer = src('../public/viewer.js')
  const pb = src('../public/playback.js')
  const pbHtml = src('../public/playback.html')
  const css = src('../public/style.css')
  const settingsJs = src('../public/settings.js')
  const settingsHtml = src('../public/settings.html')

  check('the live tiles draw it', /from '\.\/osd-overlay\.js'/.test(tile) && /drawOverlay\(\)/.test(tile))
  check('  on a canvas of their own, not on the player’s (the player would wipe it every frame)', /canvas class="osd"/.test(tile) && /canvas\.osd/.test(tile))
  check('  and nothing is drawn over a tile with no picture yet', /player\?\.videoWidth/.test(tile))
  check('the live grid tells the tiles the server’s time, not the browser’s', /clockOffsetFrom/.test(viewer) && /serverNow/.test(viewer))
  check('  measured from a request the page already makes', /headers\?\.get\?\.\('date'\)/.test(viewer))
  check('playback draws it over its own canvas', /from '\.\/osd-overlay\.js'/.test(pb) && /canvas class="osd"/.test(pbHtml))
  check('  using the same moment the timeline shows', /atMs: state\.position/.test(pb))
  check('  and it goes into a saved still as well', /drawOsd\(out\.getContext/.test(pb))
  check('the shared render loop was left alone (another change is in flight there)', !/osd/i.test(src('../public/player.js')))
  check('the overlay canvas takes no pointer events, so clicking a tile still opens it', /canvas\.osd \{[^}]*pointer-events: none/.test(css))

  check('Settings has a panel for it', /osd-title/.test(settingsHtml) && /'\/api\/admin\/osd'/.test(settingsJs))
  check('  with a corner picker', /o-corners/.test(settingsHtml) && /OSD_CORNERS/.test(settingsJs))
  check('  a fine nudge for anywhere else', /id="o-x"/.test(settingsHtml) && /id="o-y"/.test(settingsHtml))
  check('  and a preview drawn by the same layout code as the real thing', /o-preview/.test(settingsHtml) && /osdLayout\(/.test(settingsJs))
  check('  the page checks the figures before sending, and the server checks them again', /cleanOsdSettings\(osdDraft\)/.test(settingsJs))
  check('  a camera can be put back on the default', /o-reset/.test(settingsJs))
  check('the clock is labelled honestly as the server’s, not the camera’s', /server's clock|server's, not the camera's/.test(settingsHtml))
  check('  and the panel says plainly that this is not burnt into an export', /not<\/strong> in an exported MP4|not in an exported MP4/.test(settingsHtml))
}

// ---- the export path was deliberately not touched --------------------------------------------------
{
  // Exports copy the recorded stream without re-encoding, on purpose: footage that has not been
  // through an encoder again is worth more as evidence. Burning this overlay in would mean
  // re-encoding every exported clip, so it is not done, and this test is here to keep it that way.
  check('export-job.mjs knows nothing about the overlay', !/osd-overlay/.test(src('../export-job.mjs')))
  check('mp4.mjs knows nothing about the overlay', !/osd-overlay/.test(src('../mp4.mjs')))
}

// an overlay's text is a camera's name: server.mjs hands the read the rights check, so a viewer is
// told only about the cameras they may see (camera-notes.mjs handleOsd; osd-rights.test.mjs)
check('server.mjs hands /api/osd the rights check', /handleCameraOsd\([\s\S]{0,200}canSee/.test(src('../server.mjs')))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
