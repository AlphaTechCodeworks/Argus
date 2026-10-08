import { createHash } from 'node:crypto'
import { routeOf } from './security.mjs'

export function connectionOf(peer, cfHeader) {
  const route = routeOf(peer, cfHeader)
  const ip = route.address
  const privateV4 = /^10\.|^192\.168\.|^127\.|^169\.254\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  const privateV6 = /^(::1$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(ip)
  return { address: ip, connection: route.direct && (privateV4 || privateV6) ? 'LAN' : 'Web' }
}

export function makeUserSessions({ now = Date.now, ttlMs = 120_000, max = 5000 } = {}) {
  const entries = new Map()
  let lastSweep = -Infinity
  const sweep = (force = false) => {
    const time = now()
    if (!force && time - lastSweep < ttlMs / 4) return
    lastSweep = time
    for (const [key, item] of entries) if (time - item.seen > ttlMs) entries.delete(key)
  }
  return {
    touch(token, user, peer, cfHeader) {
      if (!token || !user) return
      sweep()
      const key = createHash('sha256').update(token).digest('hex')
      const previous = entries.get(key)
      entries.delete(key)
      entries.set(key, { user, ...connectionOf(peer, cfHeader), since: previous?.since ?? now(), seen: now() })
      while (entries.size > max) entries.delete(entries.keys().next().value)
    },
    list() { sweep(true); return [...entries.values()].map(entry => ({ ...entry })) },
    forgetToken(token) { if (token) entries.delete(createHash('sha256').update(token).digest('hex')) },
    forget(user) { for (const [key, item] of entries) if (item.user === user) entries.delete(key) }
  }
}
export const userSessions = makeUserSessions()
