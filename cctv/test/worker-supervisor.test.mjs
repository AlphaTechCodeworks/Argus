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

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
