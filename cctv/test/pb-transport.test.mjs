// Offline tests for the playback page's transport logic (public/pb-transport.js): the spring-back
// shuttle's rate and label, what each source is allowed to play, clamping a speed to that, frame
// stepping, when only keyframes are worth fetching and which held-key repeats are ignored.
//   node cctv/test/pb-transport.test.mjs
import { readFileSync } from 'node:fs'
import {
  DEAD_ZONE,
  SPEEDS,
  allowedSpeeds,
  clampSpeed,
  frameStep,
  ignoredRepeat,
  needsKeyframesOnly,
  shuttleLabel,
  shuttleRate
} from '../public/pb-transport.js'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

// ---- the ladder -----------------------------------------------------------------------------------
{
  check('SPEEDS is ascending', SPEEDS.every((s, i) => i === 0 || s > SPEEDS[i - 1]), SPEEDS.join(','))
  check('  every shuttle speed is one the server can play', SPEEDS.every((s) => allowedSpeeds('server').includes(s)))
  check('  the ladder is frozen', Object.isFrozen(SPEEDS))
}

// ---- the dead zone --------------------------------------------------------------------------------
{
  check('dead zone: the centre is paused', shuttleRate(0) === 0)
  check('  just inside the dead zone is still paused', shuttleRate(DEAD_ZONE - 0.001) === 0 && shuttleRate(-(DEAD_ZONE - 0.001)) === 0)
  check('  just outside it is the slowest speed', shuttleRate(DEAD_ZONE + 0.001) === SPEEDS[0], String(shuttleRate(DEAD_ZONE + 0.001)))
  check('  a wider dead zone can be asked for', shuttleRate(0.3, { dead: 0.5 }) === 0)
  check('  paused reads as paused', shuttleLabel(shuttleRate(0)) === 'paused')
}

// ---- the ends and the middle ----------------------------------------------------------------------
{
  check('the far ends give the top speed', shuttleRate(1) === SPEEDS.at(-1) && shuttleRate(-1) === -SPEEDS.at(-1))
  check('  past the ends is clamped, not extrapolated', shuttleRate(5) === SPEEDS.at(-1) && shuttleRate(-5) === -SPEEDS.at(-1))
  const mid = shuttleRate(0.5)
  check('  the middle gives a small speed', mid > 0 && mid < SPEEDS.at(-1), String(mid))
}

// ---- every rate is a real speed, and pushing further never slows down ------------------------------
{
  let allMembers = true
  let monotonic = true
  let prev = 0
  for (let i = 0; i <= 200; i++) {
    const p = i / 200
    const r = shuttleRate(p)
    if (r !== 0 && !SPEEDS.includes(r)) allMembers = false
    if (r < prev) monotonic = false
    prev = r
  }
  check('every rate is a member of SPEEDS (or 0)', allMembers)
  check('  and the rate never falls as the shuttle is pushed further', monotonic)
}

// ---- symmetry -------------------------------------------------------------------------------------
{
  let symmetric = true
  for (let i = 0; i <= 100; i++) {
    const p = i / 100
    if (shuttleRate(-p) !== -shuttleRate(p)) symmetric = false
  }
  check('reverse mirrors forward exactly', symmetric)
}

// ---- labels ---------------------------------------------------------------------------------------
{
  check('label: forward', shuttleLabel(4) === '▶ 4×', shuttleLabel(4))
  check('  reverse', shuttleLabel(-2) === '◀ 2×', shuttleLabel(-2))
  check('  paused', shuttleLabel(0) === 'paused')
}

// ---- what each source allows ----------------------------------------------------------------------
{
  const nvr = allowedSpeeds('nvr')
  check('nvr: no reverse', nvr.every((s) => s > 0), nvr.join(','))
  check('  nothing above 8', nvr.every((s) => s <= 8), nvr.join(','))
  check('  exactly 1, 2, 4, 8', nvr.join(',') === '1,2,4,8', nvr.join(','))
  const server = allowedSpeeds('server')
  check('server: reverse is allowed', server.some((s) => s < 0))
  check('  and speeds above 8', server.some((s) => s > 8))
  check('  an unknown mode is treated as the NVR (the stricter source)', allowedSpeeds('wat').join(',') === nvr.join(','))
}

// ---- clamping -------------------------------------------------------------------------------------
{
  const a = clampSpeed(16, 'nvr')
  check('clamp: 16x on the NVR becomes 8x and reports the change', a.speed === 8 && a.changed === true, JSON.stringify(a))
  const b = clampSpeed(-2, 'nvr')
  check('  reverse on the NVR becomes 1x and reports the change', b.speed === 1 && b.changed === true, JSON.stringify(b))
  const c = clampSpeed(4, 'server')
  check('  4x on the server is left alone', c.speed === 4 && c.changed === false, JSON.stringify(c))
  const d = clampSpeed(4, 'nvr')
  check('  4x on the NVR is left alone', d.speed === 4 && d.changed === false, JSON.stringify(d))
  const e = clampSpeed(3, 'nvr')
  check('  an in-between speed drops to the one below', e.speed === 2 && e.changed === true, JSON.stringify(e))
  const f = clampSpeed(0, 'nvr')
  check('  paused is not a speed to send: it becomes 1x', f.speed === 1 && f.changed === true, JSON.stringify(f))
  const g = clampSpeed(-64, 'server')
  check('  beyond the server ladder is capped at its fastest reverse', g.speed === Math.min(...allowedSpeeds('server')) && g.changed === true, JSON.stringify(g))
  let everyClampAllowed = true
  for (const mode of ['server', 'nvr']) {
    for (const s of [-64, -32, -9, -1, 0, 0.25, 1, 3, 8, 16, 100]) {
      if (!allowedSpeeds(mode).includes(clampSpeed(s, mode).speed)) everyClampAllowed = false
    }
  }
  check('  a clamped speed is always one the source allows', everyClampAllowed)
}

// ---- frame stepping -------------------------------------------------------------------------------
{
  check('step: forward one frame at 25 fps', Math.abs(frameStep(10, 1, 25) - 10.04) < 1e-9, String(frameStep(10, 1, 25)))
  check('  back one frame', Math.abs(frameStep(10, -1, 25) - 9.96) < 1e-9, String(frameStep(10, -1, 25)))
  check('  never before the start of the day', frameStep(0.01, -1, 25) === 0, String(frameStep(0.01, -1, 25)))
  check('  a missing or silly fps falls back to 25', frameStep(10, 1, 0) === frameStep(10, 1, 25))
}

// ---- keyframes only -------------------------------------------------------------------------------
{
  check('keyframes only at 8x and above', needsKeyframesOnly(8) && needsKeyframesOnly(16))
  check('  and for every reverse rate', [-1, -2, -4, -8, -16].every(needsKeyframesOnly))
  check('  but not at 1x to 4x forward', [1, 2, 4].every((r) => !needsKeyframesOnly(r)))
  check('  paused needs nothing special', needsKeyframesOnly(0) === false)
}

// ---- a held key ---------------------------------------------------------------------------------
// Holding the ±10 s or next-event key over a stretch only the NVR has started one NVR playback per
// key repeat: 17 in 2.4 s on rigginglot camera 10 put that NVR into its 60 s "busy" cool-down.
{
  const key = (k, repeat, shiftKey = false) => ({ key: k, repeat, shiftKey })
  check('held key: the repeats of ArrowLeft/ArrowRight are ignored', ignoredRepeat(key('ArrowLeft', true)) && ignoredRepeat(key('ArrowRight', true)))
  check('  with Shift too (next and previous event)', ignoredRepeat(key('ArrowLeft', true, true)) && ignoredRepeat(key('ArrowRight', true, true)))
  check('  the first press still goes', !ignoredRepeat(key('ArrowLeft', false)) && !ignoredRepeat(key('ArrowRight', false, true)))
  check('  other keys repeat as they always did (zoom, frame step)', !ignoredRepeat(key('+', true)) && !ignoredRepeat(key('-', true)) && !ignoredRepeat(key(',', true)) && !ignoredRepeat(key('.', true)))
  check('  rubbish is not ignored rather than an error', !ignoredRepeat(null) && !ignoredRepeat({}))
  const page = readFileSync(new URL('../public/playback.js', import.meta.url), 'utf8')
  check('the playback page asks before it seeks on a key', /if \(ignoredRepeat\(e\)\) return/.test(page) && /import \{[^}]*\bignoredRepeat\b[^}]*\} from '\.\/pb-transport\.js'/.test(page))
}

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
