// Tests for what is kept out of the journal of a worker's output (log-filter.mjs): the vendor SDK's
// own chatter and blank lines are dropped and counted, one line a minute says how many, the lines
// that carry a signal stay (two kinds of them once in 10 s), and everything the app prints is written
// as before. Then the same through worker-supervisor.mjs prefixLines, where onLine must still be
// shown every line. No worker is started and nothing reaches an NVR.
// Run:  node cctv/test/log-filter.test.mjs
import { EventEmitter } from 'node:events'
import { REPEAT_MS, SUMMARY_MS, isSdkChatter, makeDropCounter, makeSdkLogFilter, repeatKind, sdkKind } from '../log-filter.mjs'
import { linkResetWatch, prefixLines } from '../worker-supervisor.mjs'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}
const J = (v) => JSON.stringify(v)

// the SDK's lines, as the journal had them on 2026-10-13 (after the "[worker <id>] " prefix)
const RESET = '../../DVR_NET_SDK/source/netservice/SWL_MultiNetComm.cpp 705 : Connection reset by peer'
const TRAVERSAL = '2026-10-13 14:07:08  ../../DVR_NET_SDK/source/main_utility/NetDeviceMan.cpp(3237): WARN: CNetDeviceMan::ConnectToServerUseNAT SetConnectTraversal'
const NTOA = '2026-10-13 16:48:49  ../../DVR_NET_SDK/source/nat/NatCommon.cpp(241): INFO: NAT_inet_ntoa |IPv6| ip_str_buf=190.108.212.196'
const TRY = 'StartTryToConnect |getaddrinfo|ipv4=192.168.0.226,wDVRPort=6036,count=0'
const UDT = 'CNatUdt::Start: remote ip:190.108.212.196'
const THREAD = 'THREADDDD=#PeerBaseR,13980,../NatComm/NatPeerBase.cpp,65'
const DISCONNECTED = 'Net Disconnected...... m_deviceID = 12'
const START_FALSE = '../../DVR_NET_SDK/source/main_utility/NVRNetDevice_N9000.cpp, StartLive,2805 StartLive false channel=1,streamType=2'
const TIMEOUT = '../../DVR_NET_SDK/source/main_utility/NVRNetDevice_NN.cpp,SearchRecFile,N  NET_SDK_NETWORK_RECV_TIMEOUT'
const LOGIN_STATE = ' ../../NetDeviceN9000.cpp, ProcChannelState,1873  m_bLoginSuccess == false '

// ---- which lines are the SDK's ----
{
  for (const [name, line, kind] of [
    ['connection reset', RESET, 'network'],
    ['NAT traversal, with the SDK\'s own date in front', TRAVERSAL, 'nat'],
    ['NAT_inet_ntoa', NTOA, 'nat'],
    ['StartTryToConnect', TRY, 'network'],
    ['CNatUdt::Start', UDT, 'nat'],
    ['its thread names', THREAD, 'nat'],
    ['the login-state line', LOGIN_STATE, 'other'],
    ['an empty line', '', 'blank'],
    ['a line of spaces', '   \t ', 'blank']
  ]) check(`chatter: ${name}`, isSdkChatter(line) === true && sdkKind(line) === kind, `${sdkKind(line)}`)

  check('kept: Net Disconnected (the link-drop line)', isSdkChatter(DISCONNECTED) === false)
  check('kept: StartLive false, though it is the SDK\'s', isSdkChatter(START_FALSE) === false && repeatKind(START_FALSE) === 'startlive' && sdkKind(START_FALSE) !== null)
  check('kept: NET_SDK_NETWORK_RECV_TIMEOUT, though it is the SDK\'s', isSdkChatter(TIMEOUT) === false && repeatKind(TIMEOUT) === 'timeout')

  for (const line of [
    'stream nvr1/3:main started',
    'stream nvr1/3:sub failed to start (refused in 12 ms: cannot connect)',
    '[sdk] NET_SDK_LoginEx (login) took 3991 ms',
    '[gaps from the NVR] 9 streams had frames arrive in clumps in the last 10 min',
    '[audio] channel 6 has sound: G.711 A-law',
    '[nvr1] login to 192.168.1.50:6036 failed: cannot connect; retrying in 30s',
    '[nvr1] the NVR dropped its links: viewers\' new streams on it wait 30 s',
    'recording nvr1/2 ok',
    'Error: something the app did not expect',
    '    at file:///opt/cctv/live.mjs:294:15',
    'the file ../../DVR_NET_SDK.h was read', // words of ours that only mention a path
    '[sdk] ../../DVR_NET_SDK/source/nat/NatCommon.cpp said something' // ours: it starts with its tag
  ]) check(`not chatter: ${line.slice(0, 44)}`, isSdkChatter(line) === false && sdkKind(line) === null)
  check('nothing at all is a blank line, not a crash', isSdkChatter(undefined) === true && isSdkChatter(null) === true)
}

// ---- the count of what was dropped ----
{
  const c = makeDropCounter()
  check('nothing dropped: no line', c.take() === null)
  for (let i = 0; i < 301; i++) c.add('nat')
  for (let i = 0; i < 96; i++) c.add('network')
  for (let i = 0; i < 15; i++) c.add('other')
  const line = c.take()
  check('the summary line', line === '412 SDK lines not logged in the last minute (NAT 301, network 96, other 15)', line)
  check('...and it starts again from nothing', c.take() === null && c.total() === 0)
  c.add('blank')
  check('one line is singular', c.take() === '1 SDK line not logged in the last minute (blank 1)')
}

// ---- one worker's filter ----
{
  let t = 1_000_000
  const f = makeSdkLogFilter({ now: () => t, env: {} })
  check('the app\'s line is written as it is', J(f.lines('stream nvr1/3:main started')) === J(['stream nvr1/3:main started']))
  check('chatter is not written', J(f.lines(NTOA)) === '[]' && J(f.lines(RESET)) === '[]' && J(f.lines('')) === '[]' && J(f.lines(TRY)) === '[]')
  check('Net Disconnected is written every time', J(f.lines(DISCONNECTED)) === J([DISCONNECTED]) && J(f.lines(DISCONNECTED)) === J([DISCONNECTED]))
  t += SUMMARY_MS - 1
  check('no summary before the minute is over', J(f.lines('[sdk] something')) === J(['[sdk] something']))
  t += 1
  const out = f.lines('stream nvr1/4:sub started')
  check('the minute over: one summary, before the line that came', J(out) === J(['4 SDK lines not logged in the last minute (NAT 1, network 2, blank 1)', 'stream nvr1/4:sub started']), J(out))
  t += SUMMARY_MS
  check('a minute with nothing dropped has no summary', J(f.lines('[sdk] quiet')) === J(['[sdk] quiet']))
  f.lines(UDT)
  t += SUMMARY_MS
  check('a summary is also written ahead of a dropped line', J(f.lines(THREAD)) === J(['1 SDK line not logged in the last minute (NAT 1)']))
  check('the worker\'s output ends: the part-minute is said', J(f.end()) === J(['1 SDK line not logged in the last minute (NAT 1)']) && J(f.end()) === '[]')
}
{
  // once in REPEAT_MS for StartLive false and for the receive time-out, each on its own
  let t = 5_000_000
  const f = makeSdkLogFilter({ now: () => t, env: {} })
  check('the first StartLive false is written', J(f.lines(START_FALSE)) === J([START_FALSE]))
  t += 1000
  check('...the next ones within 10 s are not', J(f.lines(START_FALSE)) === '[]' && J(f.lines(START_FALSE)) === '[]')
  check('...the time-out has its own 10 s', J(f.lines(TIMEOUT)) === J([TIMEOUT]) && J(f.lines(TIMEOUT)) === '[]')
  t += REPEAT_MS
  const again = f.lines(START_FALSE)
  check('10 s on it is written again, with how many were left out', again.length === 1 && again[0] === `${START_FALSE}  (and 2 more like it not logged since the last)`, J(again))
  t += REPEAT_MS
  check('...and with none left out, as it is', J(f.lines(START_FALSE)) === J([START_FALSE]))
  check('those left out are not in the minute\'s summary', f.end().length === 0)
}
{
  // CCTV_LOG_SDK=all: everything written, as before; read at each line
  const env = { CCTV_LOG_SDK: 'all' }
  let t = 0
  const f = makeSdkLogFilter({ now: () => t, env })
  check('CCTV_LOG_SDK=all: chatter is written', [NTOA, RESET, '', TRY, UDT, THREAD].every((l) => J(f.lines(l)) === J([l])))
  check('...and nothing is rate-limited', J(f.lines(START_FALSE)) === J([START_FALSE]) && J(f.lines(START_FALSE)) === J([START_FALSE]))
  t += SUMMARY_MS * 2
  check('...and there is no summary', J(f.lines('[sdk] x')) === J(['[sdk] x']) && f.end().length === 0)
  delete env.CCTV_LOG_SDK
  check('switched off again: filtered from the next line', J(f.lines(NTOA)) === '[]')
  env.CCTV_LOG_SDK = 'yes'
  check('any other value is not "all"', J(f.lines(RESET)) === '[]')
}

// ---- through prefixLines: the journal, and what onLine is shown ----
const pipe = (filter) => {
  const from = new EventEmitter()
  from.setEncoding = () => {}
  const written = []
  const seen = []
  prefixLines(from, { write: (s) => written.push(s) }, '[worker gpri] ', (l) => seen.push(l), filter)
  return { feed: (...chunks) => { for (const c of chunks) from.emit('data', c) }, end: () => from.emit('end'), journal: () => written.join('').split('\n').slice(0, -1), seen }
}
{
  let t = 0
  const p = pipe(makeSdkLogFilter({ now: () => t, env: {} }))
  const all = ['stream gpri/3:sub started', NTOA, RESET, '', DISCONNECTED, TRY, START_FALSE, START_FALSE, LOGIN_STATE, '', '[sdk] NET_SDK_LoginEx (login) took 3991 ms']
  p.feed(`${all.join('\n')}\n`)
  check('the journal has the app\'s lines and the signals, prefixed', J(p.journal()) === J(['[worker gpri] stream gpri/3:sub started', `[worker gpri] ${DISCONNECTED}`, `[worker gpri] ${START_FALSE}`, '[worker gpri] [sdk] NET_SDK_LoginEx (login) took 3991 ms']), J(p.journal()))
  check('onLine is shown every line, dropped or not, in order', J(p.seen) === J(all), `${p.seen.length} of ${all.length}`)
  t += SUMMARY_MS
  p.feed('stream gpri/3:sub stopped\n')
  // (NTOA and the login-state pair are dropped by prefixLines' own older rules, before the filter)
  check('the summary is written with the worker\'s prefix', p.journal().at(-2) === '[worker gpri] 3 SDK lines not logged in the last minute (network 2, blank 1)', p.journal().at(-2))
  p.feed(UDT)
  p.end()
  check('at the end: a last line that is chatter is not written, its count is', p.journal().at(-1) === '[worker gpri] 1 SDK line not logged in the last minute (NAT 1)' && p.seen.at(-1) === UDT, p.journal().at(-1))
}
{
  // the link-drop watcher is fed from onLine: it still sees the SDK's line whatever is written
  const sent = []
  const from = new EventEmitter()
  from.setEncoding = () => {}
  prefixLines(from, { write: () => {} }, '[worker gpri] ', linkResetWatch((at) => sent.push(at), () => 42), makeSdkLogFilter({ env: {} }))
  from.emit('data', `${NTOA}\n${DISCONNECTED}\n`)
  check('the link-drop watch still fires', J(sent) === '[42]', J(sent))
}
{
  // a filter that breaks costs nothing: the lines are written as they came
  const p = pipe({ lines: () => { throw new Error('broken') }, end: () => { throw new Error('broken') } })
  p.feed(`one\n${RESET}\ntail`)
  p.end()
  check('a filter that throws: every line is written, and onLine sees them', J(p.journal()) === J(['[worker gpri] one', `[worker gpri] ${RESET}`, '[worker gpri] tail']) && p.seen.length === 3, J(p.journal()))
}
{
  // without a filter prefixLines is as it was
  const p = pipe(null)
  p.feed(`one\n${RESET}\n\n`)
  check('no filter: as before', J(p.journal()) === J(['[worker gpri] one', `[worker gpri] ${RESET}`, '[worker gpri] ']))
}

console.log(failed ? `${failed} FAILED` : 'all passed')
process.exitCode = failed ? 1 : 0
