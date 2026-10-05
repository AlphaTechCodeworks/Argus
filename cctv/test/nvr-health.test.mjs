// Tests for nvr-health.mjs: counting the streams an NVR has recently refused.
// Pure module, no I/O, no SDK. Run: node cctv/test/nvr-health.test.mjs
import { REFUSAL_WINDOW_MS, recentRefusals } from '../nvr-health.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0)
const stream = (lastFailure) => ({ lastFailure })

check('nothing to count is 0', recentRefusals([], NOW) === 0)
check('a stream that has never failed is not counted', recentRefusals([stream(null), stream(undefined), {}], NOW) === 0)
check('a recent fast refusal counts', recentRefusals([stream({ at: NOW - 60_000, fast: true })], NOW) === 1)
// A slow start is a slow network, not the NVR saying no; counting it would blame the wrong thing.
check('a slow failure is not a refusal', recentRefusals([stream({ at: NOW - 60_000, fast: false })], NOW) === 0)
check('a refusal outside the window is forgotten', recentRefusals([stream({ at: NOW - REFUSAL_WINDOW_MS - 1, fast: true })], NOW) === 0)
check('one exactly on the edge still counts', recentRefusals([stream({ at: NOW - REFUSAL_WINDOW_MS, fast: true })], NOW) === 1)
check('several are totalled', recentRefusals([stream({ at: NOW, fast: true }), stream({ at: NOW - 1000, fast: true }), stream({ at: NOW - 2000, fast: false })], NOW) === 2)
check('rubbish in a lastFailure is survivable', recentRefusals([stream({ at: 'soon', fast: true }), stream({ fast: true })], NOW) === 0)
// The worker calls this with a Map's values(); nothing at all is also allowed.
check('an iterator works, and so does nothing', recentRefusals(new Map([['a', stream({ at: NOW, fast: true })]]).values(), NOW) === 1 && recentRefusals(null, NOW) === 0)

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
