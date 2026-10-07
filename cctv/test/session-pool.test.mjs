// The playback login pool (nvrs.mjs SessionPool): at most PLAYBACK_LOGINS logins per NVR, a caller
// past that waits for one. When a login that was opening fails, a waiter gets its own try -- and it
// must find the place free: woken while the failed login still counted as opening, it only queued
// again and was refused 15 s later with a place free all along.
// nvrs.mjs loads the native SDK, so the class is taken from its source and run with stand-ins for
// what it uses: no SDK, no NVR.
// Run:  node cctv/test/session-pool.test.mjs
import { readFileSync } from 'node:fs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

const src = readFileSync(new URL('../nvrs.mjs', import.meta.url), 'utf8')
const body = src.slice(src.indexOf('class SessionPool {'), src.indexOf('// ---- one NVR ---'))
check('the class is found in nvrs.mjs', body.startsWith('class SessionPool {') && body.includes('#wakeOne()'), `${body.length} characters`)

const PLAYBACK_LOGINS = Number(src.match(/^const PLAYBACK_LOGINS = (\d+)/m)?.[1])
check('PLAYBACK_LOGINS is read from nvrs.mjs', PLAYBACK_LOGINS >= 1, String(PLAYBACK_LOGINS))

const logins = [] // the logins asked for and not answered yet: each is answered by calling it
const login = () => new Promise((r) => logins.push(r))
const answer = (userId, why = '') => logins.shift()({ userId, why })
const make = new Function('PLAYBACK_LOGINS', 'IDLE_LOGOUT_MS', 'WAIT_MS', 'SETTLE_MS', 'login', 'sleep', 'connectLane', 'PRIORITY', 'NET_SDK', 'sdkCallT', 'console', `${body}; return SessionPool`)
const SessionPool = make(PLAYBACK_LOGINS, 60_000, 1500, 0, login, () => Promise.resolve(), { run: async () => {} }, { LOW: 2 }, {}, () => {}, { log() {}, warn() {} })
const tick = () => new Promise((r) => setTimeout(r, 20))

{
  const pool = new SessionPool({ id: 'n', name: 'N', cfg: {}, stopped: false, degraded: false })
  // every login but one in use, and the last one opening
  const leases = Array.from({ length: PLAYBACK_LOGINS - 1 }, () => pool.acquire())
  for (let i = 0; i < PLAYBACK_LOGINS - 1; i++) answer(i + 1)
  await Promise.all(leases)
  const last = pool.acquire().then(() => 'a login', (e) => e.message)
  check('the pool is full: all but one in use, the last one opening', pool.inUse === PLAYBACK_LOGINS - 1 && pool.opening === 1 && logins.length === 1, `${pool.inUse} in use, ${pool.opening} opening`)
  const t0 = Date.now()
  const waiter = pool.acquire().then((l) => `a login (${l.userId})`, (e) => `refused: ${e.message}`)
  check('one more caller waits', pool.waiters.length === 1 && logins.length === 1)
  // the opening login fails: its place is free, and the waiter takes it with a login of its own
  answer(-1, 'busy')
  check('the login that was opening fails', /Playback login failed: busy/.test(await last), await last)
  await tick()
  check('... the waiter is woken into the free place: it opens its own login, and waits no more', pool.waiters.length === 0 && pool.opening === 1 && logins.length === 1, `${pool.waiters.length} waiting, ${pool.opening} opening, ${logins.length} logins asked for`)
  if (logins.length) answer(77)
  const got = await waiter
  check('... and gets it, at once rather than a refusal when its wait runs out', got === 'a login (77)' && Date.now() - t0 < 1000, `${got} after ${Date.now() - t0} ms`)
  check('the count is right afterwards: all in use, none opening', pool.inUse === PLAYBACK_LOGINS && pool.opening === 0, `${pool.inUse} in use, ${pool.opening} opening`)
}

{
  // a login that opens is counted once: in use, no longer opening
  const pool = new SessionPool({ id: 'm', name: 'M', cfg: {}, stopped: false, degraded: false })
  const one = pool.acquire()
  check('a login opening', pool.opening === 1 && pool.inUse === 0)
  answer(5)
  const lease = await one
  check('... once open, it is in use and nothing is opening', lease.userId === 5 && pool.opening === 0 && pool.inUse === 1, `${pool.inUse} in use, ${pool.opening} opening`)
  lease.release()
  check('... given back, it is kept for the next playback', pool.inUse === 0 && pool.idle.length === 1)
  clearTimeout(pool.idle[0].timer)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
