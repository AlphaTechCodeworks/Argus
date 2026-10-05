// An NVR's sub-stream limit, learnt from its refusals (sub-cap.mjs). Pure: a fake clock.
//   node cctv/test/sub-cap.test.mjs
import { CLIMB_MS, CONFIRM_MS, MIN_PLAYING, RETRY_MS, SAVED_MS, subCap } from '../sub-cap.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

let t = 1_000_000
const now = () => t
const refusal = (playing, o = {}) => ({ code: 8, fast: true, playing, ...o })

{
  const c = subCap({ now })
  check('nothing known: no limit', c.limit() === Infinity && c.known() === null && c.toJSON() === null)
  check('one "cannot connect" at 15 playing sets nothing yet', c.refused(refusal(15)) === false && c.limit() === Infinity)
  t += 30_000
  check('a second at about the same count sets the limit', c.refused(refusal(15)) === true && c.limit() === 15 && c.known() === 15)
  check('... and it is saved as { limit, at }', JSON.stringify(c.toJSON()) === JSON.stringify({ limit: 15, at: t }))
}

{
  const c = subCap({ now })
  c.refused(refusal(16))
  t += 1000
  c.refused(refusal(15))
  check('two within one of each other: the lower count', c.limit() === 15)
}

{
  const c = subCap({ now })
  c.refused(refusal(15))
  t += 1000
  check('two far apart in count do not agree', c.refused(refusal(9)) === false && c.limit() === Infinity)
  t += CONFIRM_MS + 1
  check('one older than CONFIRM_MS no longer counts', c.refused(refusal(9)) === false && c.limit() === Infinity)
}

{
  const c = subCap({ now })
  const others = [{ code: 98 }, { code: 9 }, { code: 5 }, { code: null }, { fast: false }, { playing: MIN_PLAYING - 1 }]
  for (const o of others) { c.refused(refusal(15, o)); c.refused(refusal(15, o)) }
  check('not a limit: offline camera (98), dropped session (9), other codes, a slow failure, too few playing', c.limit() === Infinity)
}

{
  const c = subCap({ now })
  c.refused(refusal(15)); c.refused(refusal(15))
  check('a stream playing beyond it raises it', c.playing(15) === false && c.playing(17) === true && c.limit() === 17)
  check('a refusal at the limit confirms it', c.refused(refusal(17)) === false && c.limit() === 17)
  check('one refusal below it does not lower it (a start that came just before a stopped stream let go)', c.refused(refusal(12)) === false && c.limit() === 17)
  t += 1000
  check('... two do', c.refused(refusal(12)) === true && c.limit() === 12)
}

{
  const c = subCap({ now })
  c.refused(refusal(15)); c.refused(refusal(15))
  t += RETRY_MS + 1
  check('not confirmed for RETRY_MS: one more stream is let through', c.limit() === 16 && c.known() === 15)
  check('... refused: the limit stands again', c.refused(refusal(15)) === false && c.limit() === 15)
  t += RETRY_MS + 1
  check('... played: it rises', c.playing(16) === true && c.limit() === 16)
  t += CLIMB_MS + 1
  check('... and the next one is tried CLIMB_MS later, not RETRY_MS', c.limit() === 17)
  check('... refused there: it stands for RETRY_MS again', c.refused(refusal(16)) === false && c.limit() === 16 && (t += CLIMB_MS + 1, c.limit() === 16))
}

{
  check('a saved limit is used after a restart', subCap({ now, saved: { limit: 15, at: t - 60_000 } }).limit() === 15)
  check('... not one older than SAVED_MS', subCap({ now, saved: { limit: 15, at: t - SAVED_MS - 1 } }).limit() === Infinity)
  check('... nor rubbish', [{ limit: 'x', at: t }, { limit: 2, at: t }, null, { limit: 15 }].every((s) => subCap({ now, saved: s }).limit() === Infinity))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
