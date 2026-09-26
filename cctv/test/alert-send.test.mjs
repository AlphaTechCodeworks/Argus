// Tests for alert-send.mjs (ntfy delivery, retries, redaction) and alert-log.mjs.
// Fakes fetch and the mailer; no network. Run: node cctv/test/alert-send.test.mjs
//
// Email is deferred, so the email success cases are not here: only that a missing mailer fails
// on its own without taking ntfy down with it.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSender } from '../alert-send.mjs'
import { appendAlert, pruneAlerts, readAlerts } from '../alert-log.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 25, 9, 0, 0)
const settings = (o = {}) => ({
  ntfy: { url: 'https://ntfy.sh', topic: 'cctv-secret-topic' },
  email: { host: 'mail.example.com', port: 587, secure: false, user: 'u', pass: 'p', from: 'cctv@example.com', to: ['mike@example.com'] },
  muted: [], notRecordingMinutes: 5, clockSkewSeconds: 30, ...o
})
const alert = (o = {}) => ({ key: 'nvr-offline/nvr-2', kind: 'nvr-offline', title: 'nvr-2 is offline', detail: 'NVR 2: the server cannot reach it.', since: T0, severity: 'high', ...o })

// --- ntfy --------------------------------------------------------------------------------------
{
  const calls = []
  const s = makeSender({ settings: settings(), fetchImpl: async (url, opt) => { calls.push({ url, opt }); return { ok: true, status: 200 } }, mailImpl: async () => {}, now: () => T0 })
  await s.deliver([alert()], 'opened')
  check('ntfy is posted to the topic url', calls[0]?.url === 'https://ntfy.sh/cctv-secret-topic', calls[0]?.url)
  check('the body carries the title and detail', calls[0].opt.body.includes('nvr-2 is offline') && calls[0].opt.body.includes('cannot reach it'))
  check('an opened alert is high priority', calls[0].opt.headers.Priority === 'high', JSON.stringify(calls[0].opt.headers))
}
{
  const calls = []
  const s = makeSender({ settings: settings(), fetchImpl: async (url, opt) => { calls.push({ url, opt }); return { ok: true, status: 200 } }, mailImpl: async () => {}, now: () => T0 })
  await s.deliver([alert()], 'cleared')
  check('a cleared alert is default priority', calls[0].opt.headers.Priority === 'default')
  check('a cleared alert says OK again', calls[0].opt.body.toLowerCase().includes('ok again'), calls[0].opt.body)
}

// --- email with no sender ----------------------------------------------------------------------
// Email is configured but the SMTP client does not exist yet: ntfy must still go out, and the
// email failure must be reported rather than thrown.
{
  let posted = 0
  const s = makeSender({ settings: settings(), fetchImpl: async () => { posted++; return { ok: true, status: 200 } }, now: () => T0, retryDelayMs: 0, log: () => {} })
  let threw = false
  let r = null
  try { r = await s.deliver([alert()], 'opened') } catch { threw = true }
  check('deliver does not throw when email cannot send', !threw)
  check('ntfy still went out', posted === 1 && r?.ntfy === true, JSON.stringify(r))
  check('the email failure is reported', r?.email === false && /not set up yet/.test(s.pending().emailError ?? ''), JSON.stringify(s.pending()))
}

// --- nothing configured ------------------------------------------------------------------------
{
  let touched = false
  const s = makeSender({ settings: settings({ ntfy: { url: '', topic: '' }, email: { host: '', port: 0, secure: false, user: '', pass: '', from: '', to: [] } }), fetchImpl: async () => { touched = true; return { ok: true } }, mailImpl: async () => { touched = true }, now: () => T0 })
  await s.deliver([alert()], 'opened')
  check('nothing is sent when nothing is configured', !touched)
}

// --- retries -----------------------------------------------------------------------------------
{
  let tries = 0
  const s = makeSender({ settings: settings(), fetchImpl: async () => { tries++; if (tries < 3) throw new Error('network down'); return { ok: true, status: 200 } }, mailImpl: async () => {}, now: () => T0, retryDelayMs: 0 })
  await s.deliver([alert()], 'opened')
  check('a failing ntfy is retried until it works', tries === 3, String(tries))
}
{
  let tries = 0
  const logged = []
  const s = makeSender({ settings: settings(), fetchImpl: async () => { tries++; throw new Error('network down') }, mailImpl: async () => {}, now: () => T0, retryDelayMs: 0, log: (l) => logged.push(l) })
  await s.deliver([alert()], 'opened')
  check('it gives up after 3 tries', tries === 3, String(tries))
  check('the failure is logged', logged.some((l) => /ntfy/.test(l)), logged.join(' | '))
  check('the last error is reported by pending()', /network down/.test(s.pending().ntfyError ?? ''), JSON.stringify(s.pending()))
}

// --- no secret in any log ----------------------------------------------------------------------
{
  const logged = []
  const s = makeSender({ settings: settings(), fetchImpl: async () => { throw new Error('boom') }, mailImpl: async () => { throw new Error('535 bad credentials') }, now: () => T0, retryDelayMs: 0, log: (l) => logged.push(l) })
  await s.deliver([alert()], 'opened')
  const all = logged.join(' ') + JSON.stringify(s.pending())
  check('the password never appears in a log or status', !all.includes('"p"') && !/pass/i.test(all.replace(/password/gi, '')), all)
  check('the ntfy topic never appears in a log', !all.includes('cctv-secret-topic'), all)
}

// --- test button -------------------------------------------------------------------------------
{
  const calls = []
  const s = makeSender({ settings: settings(), fetchImpl: async (url, opt) => { calls.push(opt); return { ok: true, status: 200 } }, mailImpl: async () => {}, now: () => T0 })
  const r = await s.test('ntfy')
  check('the ntfy test sends and reports ok', r.ok === true, JSON.stringify(r))
  check('the test message says it is a test', calls[0].body.toLowerCase().includes('test'), calls[0]?.body)
}
{
  const s = makeSender({ settings: settings(), fetchImpl: async () => ({ ok: false, status: 403 }), mailImpl: async () => {}, now: () => T0, retryDelayMs: 0 })
  const r = await s.test('ntfy')
  check('a refused test reports not ok with the status', r.ok === false && /403/.test(r.error ?? ''), JSON.stringify(r))
}

// --- the history file --------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'cctv-al-'))
  appendAlert(dir, { at: T0, event: 'opened', ...alert() })
  appendAlert(dir, { at: T0 + 60_000, event: 'cleared', ...alert() })
  const rows = readAlerts(dir, 0)
  check('both rows are read back', rows.length === 2, String(rows.length))
  check('the newest is first', rows[0].event === 'cleared', rows[0]?.event)
  check('sinceMs filters', readAlerts(dir, T0 + 30_000).length === 1)
  appendAlert(dir, { at: T0 - 40 * 86_400_000, event: 'opened', ...alert() })
  pruneAlerts(dir, T0 - 30 * 86_400_000)
  check('pruning drops rows older than the cutoff', readAlerts(dir, 0).length === 2, String(readAlerts(dir, 0).length))

  const { appendFileSync } = await import('node:fs')
  appendFileSync(join(dir, 'alerts.jsonl'), 'not json\n')
  let threw = false
  try { readAlerts(dir, 0) } catch { threw = true }
  check('a damaged line does not throw', !threw)
}

{
  // webhooks: the batch as signed JSON; settings read at each send (a change applies at once)
  const { createHmac } = await import('node:crypto')
  const posts = []
  const fetchImpl = async (url, opts) => { posts.push({ url, opts }); return { ok: true, status: 200 } }
  let current = { ntfy: { topic: '' }, webhooks: [] }
  const s = makeSender({ settings: () => current, fetchImpl, retryDelayMs: 1, log: () => {} })
  const alert = [{ key: 'offline:nvr1/3', kind: 'camera-offline', title: 'Camera 4 offline', detail: 'Main site', severity: 'high', nvr: 'nvr1', ch: 3 }]
  await s.deliver(alert, 'opened')
  check('no webhook set: nothing posted', posts.length === 0)
  current = { ntfy: { topic: '' }, webhooks: [{ url: 'https://example.test/hook', secret: 'k3y' }, { url: 'https://example.test/plain', secret: '' }] }
  const r = await s.deliver(alert, 'opened')
  check('a webhook added in Settings is used at the next send (settings read live)', posts.length === 2 && r.webhook1 === true && r.webhook2 === true, JSON.stringify(r))
  const signed = posts.find((p) => p.url.endsWith('/hook'))
  const body = JSON.parse(signed.opts.body)
  check('the body names the alert, its camera (1-based) and the kind', body.source === 'argus' && body.kind === 'opened' && body.alerts[0].camera === 4 && body.alerts[0].title === 'Camera 4 offline')
  const want = `sha256=${createHmac('sha256', 'k3y').update(signed.opts.body).digest('hex')}`
  check('with a secret: X-Argus-Signature is the HMAC-SHA256 of the exact body', signed.opts.headers['x-argus-signature'] === want)
  check('without a secret: no signature header', !('x-argus-signature' in posts.find((p) => p.url.endsWith('/plain')).opts.headers))
  const t = await s.test('webhook')
  check('the Test button posts to every webhook', t.ok && posts.length === 4 && JSON.parse(posts.at(-1).opts.body).kind === 'test')
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
