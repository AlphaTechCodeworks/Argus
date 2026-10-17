// What a viewer's device is, for the admins' "Who is watching" (Health): a few plain words made from
// the browser's User-Agent ("Windows PC · Chrome 141", "iPhone · Safari"), and, for an address on
// the network, the computer's own name where the network's DNS gives one (a reverse lookup, cached;
// never waited for: the list shows it from the next refresh). Nothing here identifies a session.
import { promises as dns } from 'node:dns'

/** @param {string|undefined} ua the request's User-Agent */
export function deviceOf(ua) {
  const s = String(ua ?? '')
  if (!s) return ''
  const app = /ArgusAndroid\/([\w.]+)(?: \(([^)]+)\))?/.exec(s)
  if (app) return `Argus app ${app[1]}${app[2] ? ` · ${app[2].trim()}` : ''}`.slice(0, 80)
  if (/okhttp/i.test(s)) return 'Argus Android app'
  let kind = ''
  if (/iPhone/.test(s)) kind = 'iPhone'
  else if (/iPad/.test(s)) kind = 'iPad'
  else if (/Android/.test(s)) {
    const model = /Android [\d.]+; ([^;)]+?)(?: Build|[;)])/.exec(s)?.[1]?.trim()
    const tv = /\bTV\b|AFT|BRAVIA|SHIELD|SmartTV/i.test(s)
    kind = `Android ${tv ? 'TV' : /Mobile/.test(s) ? 'phone' : 'tablet'}${model && model !== 'K' ? ` (${model.slice(0, 24)})` : ''}`
  } else if (/Windows NT/.test(s)) kind = 'Windows PC'
  else if (/Macintosh|Mac OS X/.test(s)) kind = 'Mac'
  else if (/CrOS/.test(s)) kind = 'Chromebook'
  else if (/Linux/.test(s)) kind = 'Linux PC'
  let browser = ''
  const v = (re) => re.exec(s)?.[1]
  if (/Edg(A|iOS)?\//.test(s)) browser = `Edge ${v(/Edg(?:A|iOS)?\/(\d+)/) ?? ''}`
  else if (/OPR\//.test(s)) browser = `Opera ${v(/OPR\/(\d+)/) ?? ''}`
  else if (/SamsungBrowser\//.test(s)) browser = `Samsung Internet ${v(/SamsungBrowser\/(\d+)/) ?? ''}`
  else if (/Firefox\/|FxiOS\//.test(s)) browser = `Firefox ${v(/(?:Firefox|FxiOS)\/(\d+)/) ?? ''}`
  else if (/Chrome\/|CriOS\//.test(s)) browser = `Chrome ${v(/(?:Chrome|CriOS)\/(\d+)/) ?? ''}`
  else if (/Safari\//.test(s)) browser = `Safari ${v(/Version\/(\d+)/) ?? ''}`
  return [kind, browser.trim()].filter(Boolean).join(' · ').slice(0, 80)
}

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/
const KEEP_MS = 30 * 60_000
const names = new Map() // address -> { at, name }

/**
 * The computer's name for an address on the network, if it is known yet ('' otherwise). The first
 * ask starts the lookup; an answer (or none) is kept for half an hour.
 * @param {string} address
 * @param {{ reverse?: (a: string) => Promise<string[]>, now?: () => number }} [o]
 */
export function hostNameOf(address, { reverse = dns.reverse, now = Date.now } = {}) {
  const a = String(address ?? '').replace(/^::ffff:/, '')
  if (!PRIVATE.test(a)) return ''
  const hit = names.get(a)
  if (hit && now() - hit.at < KEEP_MS) return hit.name
  names.set(a, { at: now(), name: hit?.name ?? '' })
  if (names.size > 2000) names.delete(names.keys().next().value)
  Promise.race([reverse(a), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 3000).unref?.())])
    .then((list) => names.set(a, { at: now(), name: String(list?.[0] ?? '').split('.')[0].replace(/[^\w-]/g, '').slice(0, 40) }))
    .catch(() => {})
  return hit?.name ?? ''
}
