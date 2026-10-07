// The requests the main process sends to an NVR's live worker and waits on (worker-requests.mjs):
// each gets an id, the reply with that id settles it, a reply that never comes times out, and a
// worker that exits fails every one still waiting. No worker is started; nothing reaches an NVR.
// Run:  node cctv/test/worker-requests.test.mjs
import { setTimeout as sleep } from 'node:timers/promises'
import { MSG } from '../worker-ipc.mjs'
import { readFileSync } from 'node:fs'
import { CALL_BUDGET_MS, REQUEST_TIMEOUT_MS, SEND_BY_MS, makeRequests } from '../worker-requests.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const J = (v) => JSON.stringify(v)

// the book's timers are unref'd (a waiting request must not keep a stopping server alive), so
// something else has to keep this script running while it waits on one
const keepAlive = setInterval(() => {}, 1000)

check('the messages exist', MSG.REQ === 'req' && MSG.RES === 'res')
// A command the worker sent just inside its send-by time still has its own time limit to run: the
// wait covers both. At the send-by time plus 5 s the caller was told "no answer" for a command the
// NVR then carried out (a reboot).
check('the default wait covers the send-by time and the longest call sent after it', SEND_BY_MS === 90_000 && REQUEST_TIMEOUT_MS === SEND_BY_MS + CALL_BUDGET_MS + 5000, `${REQUEST_TIMEOUT_MS}`)
{
  const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
  const budget = (fn) => Number((src('sdk.mjs').match(new RegExp(`^  NET_SDK_${fn}: ([\\d_]+)`, 'm'))?.[1] ?? 'x').replaceAll('_', ''))
  const calls = ['TransparentConfig', 'RebootDVR', 'ShutDownDVR'].map(budget)
  check('... which is no shorter than the time limits of the calls the worker makes (sdk.mjs)', calls.every((ms) => ms > 0 && ms <= CALL_BUDGET_MS), calls.join())
  const xml = src('nvr-xml.mjs')
  check('nvr-xml.mjs: the send-by time it gives the worker is the one the wait is counted from', /^const XML_CAP_MS = SEND_BY_MS /m.test(xml) && /^let capMs = XML_CAP_MS /m.test(xml) && (xml.match(/notAfter: Date\.now\(\) \+ capMs/g) ?? []).length === 2)
}

{
  const sent = []
  const r = makeRequests({ send: (m) => void sent.push(m) })
  const p1 = r.request({ op: 'xml', url: 'queryTimeCfg' })
  const p2 = r.request({ op: 'power', action: 'reboot' })
  check('a request is sent with its type and an id', sent[0].t === MSG.REQ && sent[0].op === 'xml' && Number.isInteger(sent[0].id), J(sent[0]))
  check('ids differ', sent[0].id !== sent[1].id)
  check('two are waiting', r.size() === 2)
  // replies out of order
  check('a reply is taken', r.onReply({ t: MSG.RES, id: sent[1].id, ok: true, accepted: true }) === true)
  check('the second request got its own reply', (await p2).accepted === true)
  r.onReply({ t: MSG.RES, id: sent[0].id, ok: true, text: '<x/>' })
  check('the first request got its own reply', (await p1).text === '<x/>')
  check('none are waiting', r.size() === 0)
  check('a reply nobody waits for is ignored', r.onReply({ t: MSG.RES, id: 999, ok: true }) === false)
}

{
  const sent = []
  const r = makeRequests({ send: (m) => void sent.push(m) })
  const p = r.request({ op: 'xml' }).catch((e) => e)
  r.onReply({ t: MSG.RES, id: sent[0].id, ok: false, error: { message: 'busy', name: 'Error', status: 503, extra: { retryAfterS: 5 } } })
  const e = await p
  check('a refusal rejects with the message, status and extra', e instanceof Error && e.message === 'busy' && e.status === 503 && e.extra?.retryAfterS === 5, J({ m: e.message, s: e.status, x: e.extra }))
  const q = r.request({ op: 'xml' }).catch((e) => e)
  r.onReply({ t: MSG.RES, id: sent[1].id, ok: false, error: { message: 'late', name: 'SdkTimeout' } })
  check("the worker's error name is kept", (await q).name === 'SdkTimeout')
}

{
  const r = makeRequests({ send: () => {}, timeoutMs: 40 })
  const t0 = Date.now()
  const e = await r.request({ op: 'xml' }).catch((e) => e)
  check('no reply: times out', e.name === 'SdkTimeout' && Date.now() - t0 >= 35, `${e.name} after ${Date.now() - t0} ms`)
  check('a timed-out request is forgotten', r.size() === 0)
  const slow = await r.request({ op: 'detail' }, { timeoutMs: 120 }).catch((e) => ({ e, ms: Date.now() }))
  check('a request can ask for a longer wait', slow.e?.name === 'SdkTimeout')
}

{
  const notSent = makeRequests({ send: () => false })
  const e = await notSent.request({ op: 'xml' }).catch((e) => e)
  check('nothing sent: refused at once', e.name === 'WorkerNotReady' && notSent.size() === 0, e.name)
  const throws = makeRequests({ send: () => { throw new Error('channel closed') } })
  check('a send that throws is the same refusal', (await throws.request({ op: 'xml' }).catch((e) => e)).name === 'WorkerNotReady')
}

{
  const r = makeRequests({ send: () => {} })
  const ps = [r.request({ op: 'xml' }).catch((e) => e), r.request({ op: 'power' }).catch((e) => e)]
  r.failAll('the video connection restarted')
  const [a, b] = await Promise.all(ps)
  check('the worker went: every waiting request fails', a.name === 'WorkerLost' && b.name === 'WorkerLost' && a.message === 'the video connection restarted')
  check('and none are left', r.size() === 0)
  await sleep(10)
}

clearInterval(keepAlive)

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
