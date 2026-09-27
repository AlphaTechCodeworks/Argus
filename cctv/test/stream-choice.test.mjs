// Tests for stream-choice.mjs: what to record when the NVR will not give us the main stream.
//   node cctv/test/stream-choice.test.mjs
//
// The case this exists for, from nvr-2 on 2026-09-25: 32 cameras, 128 Mb of a 192 Mb budget spent,
// channels 1-17 recording and every refusal on 18-32. Eleven cameras online, healthy on every
// page, and not a frame written. Recording those at reduced quality is worth having; recording
// them not at all is the failure nobody notices until they go looking for the footage.
import { MAIN, SUB, afterRefusal, afterVideo, chooseStream, degradedNote } from '../stream-choice.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 25, 20, 0, 0)
const MIN = 60_000

// ---- the ordinary case -------------------------------------------------------------------------
{
  const fresh = { refusals: 0, onSub: false, subSince: 0 }
  check('a camera with no trouble records the main stream', chooseStream(fresh, T0).type === MAIN)
  check('and is not reported as degraded', degradedNote(fresh, T0) === null)
  // One refusal is not a pattern: an NVR busy for a moment should not downgrade a camera.
  const once = afterRefusal(fresh, T0)
  check('one refusal is not enough to give up on quality', chooseStream(once, T0).type === MAIN, JSON.stringify(once))
}

// ---- the failure this fixes --------------------------------------------------------------------
{
  let s = { refusals: 0, onSub: false, subSince: 0 }
  s = afterRefusal(s, T0)
  s = afterRefusal(s, T0 + 5 * MIN)
  const d = chooseStream(s, T0 + 5 * MIN)
  check('two refusals in a row move it to the sub-stream', d.type === SUB && d.changed === true, JSON.stringify(d))
  check('and it says why in words a person can act on', /refused the main stream/.test(d.why), d.why)

  // Video arrives on the sub-stream: it is recording again, at reduced quality.
  s = afterVideo(s, T0 + 6 * MIN, SUB)
  check('the refusal count resets once video flows', s.refusals === 0)
  check('it is marked as being on the sub-stream', s.onSub === true && s.subSince === T0 + 6 * MIN)
  check('and it stays there rather than flapping', chooseStream(s, T0 + 7 * MIN).type === SUB)
  check('the page is told it is degraded, and for how long', /sub-stream for 14 min/.test(degradedNote(s, T0 + 20 * MIN)), String(degradedNote(s, T0 + 20 * MIN)))
}

// ---- coming back up --------------------------------------------------------------------------
{
  // A camera must not stay degraded for ever because of one bad afternoon.
  const onSub = { refusals: 0, onSub: true, subSince: T0 }
  check('it does not give up quality permanently', chooseStream(onSub, T0 + 31 * MIN).type === MAIN, 'should retry the main stream')
  check('but it does not retry constantly either', chooseStream(onSub, T0 + 29 * MIN).type === SUB)

  // The retry works: full quality again, and the degraded mark is cleared.
  const back = afterVideo(onSub, T0 + 31 * MIN, MAIN)
  check('once the main stream works it is no longer degraded', back.onSub === false && back.subSince === 0 && degradedNote(back, T0 + 31 * MIN) === null)

  // The retry fails: it must not be treated as a fresh camera and sent round the loop slowly.
  let again = afterRefusal(onSub, T0 + 31 * MIN)
  again = afterRefusal(again, T0 + 32 * MIN)
  check('a failed retry goes straight back to the sub-stream', chooseStream(again, T0 + 32 * MIN).type === SUB)

  // The clock measures how long it has been degraded, not how long since the last frame.
  const long = afterVideo({ refusals: 0, onSub: true, subSince: T0 }, T0 + 45 * MIN, SUB)
  check('the degraded clock is not restarted by every frame', long.subSince === T0, String(long.subSince))
}

// ---- when there is nothing left ----------------------------------------------------------------
{
  // The sub-stream refused as well: the NVR has nothing to give. There is nowhere further down,
  // and the count must keep rising so the caller's backoff keeps lengthening.
  let s = { refusals: 0, onSub: true, subSince: T0 }
  s = afterRefusal(s, T0 + MIN)
  s = afterRefusal(s, T0 + 2 * MIN)
  s = afterRefusal(s, T0 + 3 * MIN)
  check('a refused sub-stream keeps counting rather than looping', s.refusals === 3)
  check('and it does not pretend there is a better option', chooseStream(s, T0 + 3 * MIN).type === SUB)
}

// ---- the switch ----------------------------------------------------------------------------------
{
  // Somebody may prefer a clean gap to reduced-quality footage. Off means off, including for a
  // camera already on the sub-stream, which must be pulled back rather than left there.
  let s = { refusals: 5, onSub: true, subSince: T0 }
  const d = chooseStream(s, T0 + MIN, { allowSub: false })
  check('switched off, it asks for the main stream or nothing', d.type === MAIN && d.changed === true, JSON.stringify(d))
  s = { refusals: 9, onSub: false, subSince: 0 }
  check('and never falls back however many times it is refused', chooseStream(s, T0, { allowSub: false }).type === MAIN)
}

// ---- nothing here blows up on rubbish ------------------------------------------------------------
{
  check('an empty state is the ordinary case, not a crash', chooseStream({}, T0).type === MAIN && chooseStream(undefined, T0).type === MAIN)
  check('a missing timestamp does not make a degraded note lie', degradedNote({ onSub: true, subSince: 0 }, T0) === 'recording the sub-stream: the NVR would not give the main one')
  check('counting from nothing still counts', afterRefusal(undefined, T0).refusals === 1)
}

// ---- a fixed choice per camera or NVR (settings recording.stream) ---------------------------------
// nvr-2 on 2026-09-27: its own disk held channels 23 and 30 in full (114.8 of 115 min), while the
// server-side recording of their main streams gapped every ~5 s -- the NVR, near its serving budget,
// would not relay them smoothly, and even one camera moved to the sub-stream kept gapping while the
// other 24 main streams still loaded the NVR. Recording the whole NVR on sub-streams is the fix.
{
  const fresh = { refusals: 0, onSub: false, subSince: 0 }
  check("prefer 'sub': records the sub-stream from the start", chooseStream(fresh, T0, { prefer: 'sub' }).type === SUB)
  const refusedMain = { refusals: 5, onSub: false, subSince: 0 }
  check("prefer 'sub': whatever the refusal count", chooseStream(refusedMain, T0, { prefer: 'sub' }).type === SUB)
  const onSubLong = { refusals: 0, onSub: true, subSince: T0 - 60 * MIN }
  check("prefer 'sub': never retries the main stream (no 30-min probe)", chooseStream(onSubLong, T0, { prefer: 'sub' }).type === SUB)
  check("prefer 'main': the main stream even after refusals", chooseStream(refusedMain, T0, { prefer: 'main' }).type === MAIN)
  check("prefer 'main': overrides the sub fallback", chooseStream({ refusals: 2, onSub: false }, T0, { prefer: 'main', allowSub: true }).type === MAIN)
  check("prefer 'auto' (the default): unchanged behaviour", chooseStream(refusedMain, T0, { prefer: 'auto' }).type === SUB && chooseStream(fresh, T0).type === MAIN)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
