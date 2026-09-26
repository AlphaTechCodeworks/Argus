// Delivery: pushes alerts to ntfy, email and webhooks (other systems: a signed JSON POST). Never throws at the caller and never blocks the
// check loop — a send that fails is retried up to 3 times, then logged and reported by pending()
// so the Health page can say "email failing".
//
// Secrets (the email password, the ntfy topic) never appear in a log line or in pending():
// the topic is part of a URL that would let anyone send to the owner's phone, so a log line
// names the method only, never the URL it posted to.
//
// Email is not built yet (see the scope change in the health-alerts plan): the settings and this
// code path stay so nothing has to be rewired later, but mailImpl defaults to a stub that fails.
// A caller that wants email passes a real sender in.

import { createHmac } from 'node:crypto'

const TRIES = 3
export const MAX_WEBHOOKS = 5
const RETRY_DELAY_MS = 100_000 // ~5 min over 3 tries

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The stand-in for the SMTP client that has not been written yet. */
const noMailer = async () => { throw new Error('email is not set up yet') }

/**
 * @param {object} o
 * @param {object | (() => object)} o.settings   settings.alerts, or a function giving the current one
 *   (the sender reads it at each send: a topic or webhook changed in Settings applies at once)
 * @param {typeof fetch} [o.fetchImpl]
 * @param {(cfg: object, msg: object) => Promise<void>} [o.mailImpl]
 * @param {() => number} [o.now]
 * @param {number} [o.retryDelayMs]
 * @param {(line: string) => void} [o.log]
 */
export function makeSender({ settings, fetchImpl = fetch, mailImpl = noMailer, now = Date.now, retryDelayMs = RETRY_DELAY_MS, log = console.log }) {
  const status = { ntfyError: null, emailError: null, webhookError: null }
  const cfg = () => (typeof settings === 'function' ? settings() : settings) ?? {}

  const ntfyOn = () => Boolean(cfg().ntfy?.topic)
  const emailOn = () => Boolean(cfg().email?.host && cfg().email?.to?.length)
  const hooks = () => (Array.isArray(cfg().webhooks) ? cfg().webhooks.filter((h) => h?.url).slice(0, MAX_WEBHOOKS) : [])

  async function attempt(name, fn) {
    let last = null
    for (let i = 0; i < TRIES; i++) {
      try { await fn(); status[`${name}Error`] = null; return true }
      catch (e) { last = e; if (i < TRIES - 1) await sleep(retryDelayMs) }
    }
    status[`${name}Error`] = last?.message ?? 'failed'
    log(`[alerts] ${name} failed after ${TRIES} tries: ${last?.message ?? 'failed'}`)
    return false
  }

  const line = (a) => `${a.title}${a.detail ? ` — ${a.detail}` : ''}`
  const stamp = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const subject = (alerts) => `CCTV: ${alerts[0].title}${alerts.length > 1 ? ` (and ${alerts.length - 1} more)` : ''}`

  function text(alerts, kind) {
    if (kind === 'report') return alerts.map((a) => a.detail ?? '').join('\n\n')
    const head = kind === 'cleared' ? 'OK again:' : 'Problem:'
    return [`${head}`, ...alerts.map((a) => `${stamp(now())}  ${line(a)}`)].join('\n')
  }

  async function ntfy(alerts, kind) {
    const n = cfg().ntfy
    const base = (n.url || 'https://ntfy.sh').replace(/\/+$/, '')
    const url = `${base}/${n.topic}`
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Title: subject(alerts),
        Priority: kind === 'report' ? 'low' : kind === 'cleared' ? 'default' : 'high',
        Tags: kind === 'report' ? 'bar_chart' : kind === 'cleared' ? 'white_check_mark' : 'rotating_light'
      },
      body: text(alerts, kind)
    })
    // The status only — never the url, which carries the topic.
    if (!res?.ok) throw new Error(`the ntfy server answered ${res?.status ?? 'nothing'}`)
  }

  async function email(alerts, kind) {
    const e = cfg().email
    await mailImpl(
      { host: e.host, port: e.port, secure: e.secure, user: e.user, pass: e.pass, from: e.from },
      { to: e.to, subject: subject(alerts), text: text(alerts, kind) }
    )
  }

  /**
   * One webhook: the batch as JSON. With a secret, the body is signed: X-Argus-Signature is
   * "sha256=" + the hex HMAC-SHA256 of the exact body with that secret, so the other system can tell
   * it came from this server. Never logged: the URL may carry a token.
   */
  async function webhook(hook, alerts, kind) {
    const body = JSON.stringify({
      source: 'argus',
      kind, // 'opened' | 'cleared' | 'test'
      at: new Date(now()).toISOString(),
      alerts: alerts.map((a) => ({
        key: a.key ?? null,
        kind: a.kind ?? a.type ?? null,
        title: a.title ?? null,
        detail: a.detail ?? '',
        severity: a.severity ?? a.priority ?? null,
        nvr: a.nvr ?? null,
        camera: Number.isInteger(a.ch) ? a.ch + 1 : null,
        startMs: a.startMs ?? null
      }))
    })
    const headers = { 'content-type': 'application/json', 'user-agent': 'Argus-CCTV' }
    if (hook.secret) headers['x-argus-signature'] = `sha256=${createHmac('sha256', String(hook.secret)).update(body).digest('hex')}`
    const res = await fetchImpl(hook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) })
    if (!res?.ok) throw new Error(`the webhook answered ${res?.status ?? 'nothing'}`)
  }

  return {
    /** Sends one batch. Resolves when every method has finished or given up. */
    async deliver(alerts, kind) {
      if (!alerts?.length) return { ntfy: null, email: null }
      const jobs = []
      if (ntfyOn()) jobs.push(attempt('ntfy', () => ntfy(alerts, kind)).then((ok) => ['ntfy', ok]))
      if (emailOn()) jobs.push(attempt('email', () => email(alerts, kind)).then((ok) => ['email', ok]))
      for (const [i, h] of hooks().entries()) jobs.push(attempt('webhook', () => webhook(h, alerts, kind)).then((ok) => [`webhook${i + 1}`, ok]))
      const done = await Promise.all(jobs)
      return Object.fromEntries(done)
    },

    /** The Test button. method: 'ntfy' | 'email' | 'webhook' (every webhook set). */
    async test(method) {
      const a = [{ key: 'test', kind: 'test', title: 'Test message', detail: 'If you can read this, alerts are working.', severity: 'medium' }]
      try {
        if (method === 'ntfy') { if (!ntfyOn()) return { ok: false, error: 'no ntfy topic set' }; await ntfy(a, 'opened') }
        else if (method === 'webhook') {
          if (!hooks().length) return { ok: false, error: 'no webhook set' }
          for (const h of hooks()) await webhook(h, a, 'test')
        }
        else { if (!emailOn()) return { ok: false, error: 'no mail server or recipient set' }; await email(a, 'opened') }
        return { ok: true }
      } catch (e) { return { ok: false, error: e.message } }
    },

    /** What is currently failing, for the Health page. Carries no secret. */
    pending: () => ({ ...status })
  }
}
