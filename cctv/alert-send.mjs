// Delivery: pushes alerts to ntfy and email. Never throws at the caller and never blocks the
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

const TRIES = 3
const RETRY_DELAY_MS = 100_000 // ~5 min over 3 tries

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The stand-in for the SMTP client that has not been written yet. */
const noMailer = async () => { throw new Error('email is not set up yet') }

/**
 * @param {object} o
 * @param {object} o.settings   settings.alerts
 * @param {typeof fetch} [o.fetchImpl]
 * @param {(cfg: object, msg: object) => Promise<void>} [o.mailImpl]
 * @param {() => number} [o.now]
 * @param {number} [o.retryDelayMs]
 * @param {(line: string) => void} [o.log]
 */
export function makeSender({ settings, fetchImpl = fetch, mailImpl = noMailer, now = Date.now, retryDelayMs = RETRY_DELAY_MS, log = console.log }) {
  const status = { ntfyError: null, emailError: null }

  const ntfyOn = () => Boolean(settings.ntfy?.topic)
  const emailOn = () => Boolean(settings.email?.host && settings.email?.to?.length)

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
    const head = kind === 'cleared' ? 'OK again:' : 'Problem:'
    return [`${head}`, ...alerts.map((a) => `${stamp(now())}  ${line(a)}`)].join('\n')
  }

  async function ntfy(alerts, kind) {
    const base = (settings.ntfy.url || 'https://ntfy.sh').replace(/\/+$/, '')
    const url = `${base}/${settings.ntfy.topic}`
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Title: subject(alerts),
        Priority: kind === 'cleared' ? 'default' : 'high',
        Tags: kind === 'cleared' ? 'white_check_mark' : 'rotating_light'
      },
      body: text(alerts, kind)
    })
    // The status only — never the url, which carries the topic.
    if (!res?.ok) throw new Error(`the ntfy server answered ${res?.status ?? 'nothing'}`)
  }

  async function email(alerts, kind) {
    const e = settings.email
    await mailImpl(
      { host: e.host, port: e.port, secure: e.secure, user: e.user, pass: e.pass, from: e.from },
      { to: e.to, subject: subject(alerts), text: text(alerts, kind) }
    )
  }

  return {
    /** Sends one batch. Resolves when every method has finished or given up. */
    async deliver(alerts, kind) {
      if (!alerts?.length) return { ntfy: null, email: null }
      const jobs = []
      if (ntfyOn()) jobs.push(attempt('ntfy', () => ntfy(alerts, kind)).then((ok) => ['ntfy', ok]))
      if (emailOn()) jobs.push(attempt('email', () => email(alerts, kind)).then((ok) => ['email', ok]))
      const done = await Promise.all(jobs)
      return Object.fromEntries(done)
    },

    /** The Test button. method: 'ntfy' | 'email'. */
    async test(method) {
      const a = [{ key: 'test', kind: 'test', title: 'Test message', detail: 'If you can read this, alerts are working.', severity: 'medium' }]
      try {
        if (method === 'ntfy') { if (!ntfyOn()) return { ok: false, error: 'no ntfy topic set' }; await ntfy(a, 'opened') }
        else { if (!emailOn()) return { ok: false, error: 'no mail server or recipient set' }; await email(a, 'opened') }
        return { ok: true }
      } catch (e) { return { ok: false, error: e.message } }
    },

    /** What is currently failing, for the Health page. Carries no secret. */
    pending: () => ({ ...status })
  }
}
