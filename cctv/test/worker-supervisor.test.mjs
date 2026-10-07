// Tests for how a live worker's output reaches the journal (worker-supervisor.mjs prefixLines): each
// line prefixed, except the SDK's "ProcChannelState ... m_bLoginSuccess == false" line and the blank
// line it prints after it, about half of the journal on a normal day (playback report, log noise).
// Every line, those included, still reaches onLine, where the link-drop watcher reads the SDK's output.
// No worker is started and nothing reaches an NVR.
// Run:  node cctv/test/worker-supervisor.test.mjs
import { EventEmitter } from 'node:events'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const J = (v) => JSON.stringify(v)

const { prefixLines } = await import('../worker-supervisor.mjs')
check('worker-supervisor.mjs exports prefixLines', typeof prefixLines === 'function')

/** A child's stdout stand-in: chunks go in with feed(), the journal side is `written`, onLine's lines `seen`. */
const pipe = () => {
  const from = new EventEmitter()
  from.setEncoding = () => {}
  const written = []
  const seen = []
  prefixLines?.(from, { write: (s) => written.push(s) }, '[worker w1] ', (l) => seen.push(l))
  return {
    feed: (...chunks) => {
      for (const c of chunks) from.emit('data', c)
    },
    end: () => from.emit('end'),
    journal: () => written.join('').split('\n').slice(0, -1),
    seen
  }
}
// the SDK's line, as its format string prints it: " %s, %s,%d  m_bLoginSuccess == false "
const NOISE = ' ../../NetDeviceN9000.cpp, ProcChannelState,1873  m_bLoginSuccess == false '

{
  const p = pipe()
  p.feed(`stream w1/3:sub started\n${NOISE}\n\nNet Disconnected...... m_deviceID = 29\n`)
  check('the ProcChannelState line and the blank line after it are not written', J(p.journal()) === J(['[worker w1] stream w1/3:sub started', '[worker w1] Net Disconnected...... m_deviceID = 29']), J(p.journal()))
  check('... but every line, those included, reaches onLine', J(p.seen) === J(['stream w1/3:sub started', NOISE, '', 'Net Disconnected...... m_deviceID = 29']), J(p.seen))
}
{
  // the SDK's output arrives in whatever pieces the pipe gives: the line split, its blank line in the next chunk
  const p = pipe()
  p.feed(`recording w1/2 ok\n ../../NetDeviceN9000.cpp, ProcCha`, 'nnelState,1873  m_bLoginSuccess == false \n', '\n', 'after\n')
  check('split across chunks: still dropped, blank line included', J(p.journal()) === J(['[worker w1] recording w1/2 ok', '[worker w1] after']), J(p.journal()))
  check('... and still seen by onLine', p.seen.length === 4 && p.seen[1] === NOISE && p.seen[2] === '', J(p.seen))
}
{
  // a run of them, as a reconnect prints for each channel
  const p = pipe()
  p.feed(`${NOISE}\n\n${NOISE}\n\n${NOISE}\n\nlast\n`)
  check('a run of them: none written', J(p.journal()) === J(['[worker w1] last']), J(p.journal()))
  check('... all seen', p.seen.length === 7)
}
{
  // only the blank line right after the SDK's line goes: other blank lines are output like any other
  const p = pipe()
  p.feed('first\n\nsecond\n')
  check('a blank line that does not follow it is kept', J(p.journal()) === J(['[worker w1] first', '[worker w1] ', '[worker w1] second']), J(p.journal()))
  const q = pipe()
  q.feed(`${NOISE}\nnot blank\n\n`)
  check('... and only one blank line after it, not a later one', J(q.journal()) === J(['[worker w1] not blank', '[worker w1] ']), J(q.journal()))
}
{
  // the stream ends on a partial line: written as before, unless it is the SDK's line
  const p = pipe()
  p.feed('tail without newline')
  p.end()
  check('a last line without a newline is still written at the end', J(p.journal()) === J(['[worker w1] tail without newline']) && p.seen.at(-1) === 'tail without newline', J(p.journal()))
  const q = pipe()
  q.feed(NOISE)
  q.end()
  check('... but not when it is the SDK\'s line (onLine still sees it)', J(q.journal()) === J([]) && q.seen.at(-1) === NOISE, J(q.journal()))
}
{
  // an ordinary line that only mentions one of the words is not dropped
  const p = pipe()
  p.feed('[nvr1] ProcChannelState is the SDK function that logs logins\nm_bLoginSuccess == true\n')
  check('lines that are not the SDK\'s login-state line are written', p.journal().length === 2, J(p.journal()))
}
{
  // The SDK prints this for every address it formats over a NAT 1.0 link. On 2026-10-07 it was 98 % of
  // the journal (about 235,000 lines in ten minutes, from two sites), which filled the 500 MB cap in
  // two and a half hours: nothing was left of the night's restart at 06:10 by the time it was looked for.
  const NTOA = '2026-10-07 14:31:43  ../../DVR_NET_SDK/source/nat/NatCommon.cpp(241): INFO: NAT_inet_ntoa |IPv6| ip_str_buf=181.41.121.88'
  const p = pipe()
  p.feed(`before\n${NTOA}\n${NTOA}\n${NTOA}\nafter\n`)
  check('the NAT_inet_ntoa line is not written, however many', J(p.journal()) === J(['[worker w1] before', '[worker w1] after']), J(p.journal()))
  check('... but every one reaches onLine', p.seen.length === 5 && p.seen[1] === NTOA, J(p.seen.length))
  // unlike the login-state line it has no blank line of its own: one that follows is real output
  const q = pipe()
  q.feed(`${NTOA}\n\nnext\n`)
  check('a blank line after it is kept', J(q.journal()) === J(['[worker w1] ', '[worker w1] next']), J(q.journal()))
  // the SDK's other NAT lines say something (a relay chosen, a search that failed): they stay
  const r = pipe()
  r.feed('2026-10-07 14:31:43  ../../DVR_NET_SDK/source/nat/ClientConnMan.cpp(301): INFO: Search device info failed!\n')
  check('other SDK NAT lines are still written', p.journal().length === 2 && r.journal().length === 1, J(r.journal()))
  const s = pipe()
  s.feed(NTOA)
  s.end()
  check('a last NAT_inet_ntoa line without a newline is not written either', s.journal().length === 0 && s.seen.at(-1) === NTOA, J(s.journal()))
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
