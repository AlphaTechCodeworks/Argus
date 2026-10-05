// The stream a /live or /playback URL asks for (stream-param.mjs): parsed once, strictly, because
// Number() read '', ' ', '0.0', '0x0', '-0' and more as 0, the main stream. Pure: runs anywhere.
//   node cctv/test/stream-param.test.mjs
import { HD_ASK_MESSAGE, HD_NOT_ALLOWED, HD_ONLY_MESSAGE, MAIN, SUB, streamParam } from '../stream-param.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
// what the servers read: URLSearchParams.get, as server.mjs and rec-playback.mjs do
const q = (s) => new URL(`ws://x/live?nvr=n&ch=1${s}`).searchParams.get('stream')

check('absent: the sub-stream (as always)', streamParam(q('')) === SUB && streamParam(null) === SUB && streamParam(undefined) === SUB)
check('exactly 0 and exactly 1', streamParam(q('&stream=0')) === MAIN && streamParam(q('&stream=1')) === SUB && MAIN === 0 && SUB === 1)
const MAIN_TO_NUMBER = ['&stream=', '&stream=%20', '&stream=0.0', '&stream=0x0', '&stream=0b0', '&stream=0o0', '&stream=0e5', '&stream=-0', '&stream=%2B0', '&stream=%0A0', '&stream=%200', '&stream=00']
check('each of these was the main stream to Number() (the loophole)', MAIN_TO_NUMBER.every((s) => Number(q(s)) === 0), MAIN_TO_NUMBER.filter((s) => Number(q(s)) !== 0).join(' '))
const loose = [...MAIN_TO_NUMBER, '&stream=01', '&stream=2', '&stream=main', '&stream=1.0'].filter((s) => !Number.isNaN(streamParam(q(s))))
check('... and each is no stream at all now (NaN, which every caller refuses)', loose.length === 0, loose.join(' '))
check('repeated: the first one counts (URLSearchParams.get)', streamParam(q('&stream=1&stream=0')) === SUB && streamParam(q('&stream=0&stream=1')) === MAIN)
check('NaN never passes a [0, 1] check', ![0, 1].includes(streamParam('x')))
check('the refusal reason and the two messages', HD_NOT_ALLOWED === 'hd not allowed' && /Playback HD or Live HD/.test(HD_ASK_MESSAGE) && /No SD recording/.test(HD_ONLY_MESSAGE) && /only in HD/.test(HD_ONLY_MESSAGE))

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
