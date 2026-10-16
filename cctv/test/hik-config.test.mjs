// hik-config.mjs: a Hikvision device's record (validation, defaults), Hik-Connect staying off until
// Hikvision's developer values are there (nothing guessed), secrets never shown, and the SDK's place.
//   node cctv/test/hik-config.test.mjs
import { HIK_SDK_DEFAULT_DIR, cleanHikFields, cleanP2p, hikChildEnv, hikSdkDir, isHik, p2pSettings, p2pState, publicP2p } from '../hik-config.mjs'
import { P2P_NOT_SET_UP } from '../hik-core.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const J = (v) => JSON.stringify(v)
const throws = (fn, re) => {
  try {
    fn()
    return false
  } catch (e) {
    return re ? re.test(e.message) : true
  }
}
const noEnv = {}

// ---- the record ----
const f = cleanHikFields({ site: ' Yard ', name: 'Gate', host: '192.168.1.64', user: 'admin' }, { env: noEnv })
check('brand hikvision, trimmed, port 8000 by default', J(f) === J({ brand: 'hikvision', site: 'Yard', name: 'Gate', user: 'admin', host: '192.168.1.64', port: 8000 }), J(f))
check('a port given is kept', cleanHikFields({ site: 'a', name: 'b', host: 'nvr.local', port: 8001, user: 'u' }, { env: noEnv }).port === 8001)
check('a bad port is refused', throws(() => cleanHikFields({ site: 'a', name: 'b', host: 'h', port: 70000, user: 'u' }, { env: noEnv }), /Port/))
check('no address is refused (plainly)', throws(() => cleanHikFields({ site: 'a', name: 'b', user: 'u' }, { env: noEnv }), /IP address or host name/))
check('an address with a space is refused', throws(() => cleanHikFields({ site: 'a', name: 'b', host: '1.2.3.4 x', user: 'u' }, { env: noEnv })))
check('user name is required', throws(() => cleanHikFields({ site: 'a', name: 'b', host: 'h' }, { env: noEnv }), /User name is required/))
check('a TVT serial number is refused for a Hikvision device', throws(() => cleanHikFields({ site: 'a', name: 'b', host: 'h', user: 'u', sn: 'ABCDEF123' }, { env: noEnv }), /not by a TVT serial/))
check('edit: only what was sent', J(cleanHikFields({ name: 'New' }, { partial: true, env: noEnv })) === J({ brand: 'hikvision', name: 'New' }))
check('isHik', isHik({ brand: 'hikvision' }) && !isHik({ host: 'x' }) && !isHik(null))

// ---- Hik-Connect ----
check('no p2p block: off, with the developer-access message', p2pState({}, noEnv).state === 'off' && p2pState({}, noEnv).message === P2P_NOT_SET_UP)
check('switching it on without AppID and addresses is refused, with the message', throws(() => cleanP2p({ enabled: true, account: 'a@b.c', password: 'x' }, null, noEnv), /Hik-Connect developer access/))
const saved = cleanP2p({ enabled: false, account: 'me@example.com', password: 'pw1' }, null, noEnv)
check('account and password kept while off', saved.account === 'me@example.com' && saved.password === 'pw1' && saved.enabled === false)
check('still off (needs access)', p2pState({ p2p: saved }, noEnv).state === 'off' && J(p2pState({ p2p: saved }, noEnv).missing) === J(['appId', 'authAddr', 'platformAddr', 'platformType']))
const dev = { appId: 'APP-123', authAddr: 'auth.example.test', platformAddr: 'https://platform.example.test:443', platformType: 0 }
const on = cleanP2p({ enabled: true, ...dev }, saved, noEnv)
check('with all four developer values (type 0 counts), it can be switched on', on.enabled === true && on.platformType === 0 && on.password === 'pw1')
check('ready (and said to be unproven)', p2pState({ p2p: on }, noEnv).state === 'ready' && /not yet proven/.test(p2pState({ p2p: on }, noEnv).message))
check('an empty secret keeps the stored one', cleanP2p({ password: '', appId: '' }, on, noEnv).password === 'pw1' && cleanP2p({ appId: '' }, on, noEnv).appId === 'APP-123')
check('on, but no account: refused', throws(() => cleanP2p({ enabled: true, ...dev }, null, noEnv), /account/))
check('platform type must be 0-255', throws(() => cleanP2p({ platformType: 300 }, null, noEnv), /0-255/) && throws(() => cleanP2p({ platformType: 1.5 }, null, noEnv)))
check('an address with a space is refused', throws(() => cleanP2p({ authAddr: 'a b' }, null, noEnv), /no spaces/))
check('clear: removes the whole block', cleanP2p({ clear: true }, on, noEnv) === null && cleanP2p(null, on, noEnv) === null)
// the server's environment can give the developer values (one place for every device); never a default
const env = { CCTV_HIK_P2P_APPID: 'SRV-APP', CCTV_HIK_P2P_AUTH_ADDR: 'a.test', CCTV_HIK_P2P_PLATFORM_ADDR: 'p.test', CCTV_HIK_P2P_PLATFORM_TYPE: '2' }
const viaEnv = cleanP2p({ enabled: true, account: 'x@y.z', password: 'p' }, null, env)
check('developer values from the environment allow switching on', viaEnv.enabled === true && viaEnv.appId === undefined)
check('effective values: device first, then the environment', J(p2pSettings({ p2p: { ...viaEnv, appId: 'DEV-APP' } }, env)) === J({ enabled: true, account: 'x@y.z', password: 'p', appId: 'DEV-APP', authAddr: 'a.test', platformAddr: 'p.test', platformType: 2 }))
check('a bad platform type in the environment is not used', p2pSettings({}, { ...env, CCTV_HIK_P2P_PLATFORM_TYPE: 'x' }).platformType === undefined)
check('nothing at all: every developer value undefined (no invented defaults)', J(p2pSettings({}, noEnv)) === J({ enabled: false, account: '', password: '' }))

// ---- what the page sees ----
const pub = publicP2p({ p2p: on }, noEnv)
const text = J(pub)
check('public view: no secret values', !text.includes('pw1') && !text.includes('APP-123') && !text.includes('auth.example.test') && !text.includes('platform.example.test'))
check('public view: whether each is set, the account, the state', pub.passwordSet && pub.appIdSet && pub.authAddrSet && pub.platformAddrSet && pub.platformTypeSet && pub.account === 'me@example.com' && pub.state === 'ready')
const pubEnv = publicP2p({ p2p: viaEnv }, env)
check('public view: values set for the whole server are marked so (still not shown)', pubEnv.fromServer.appId && !pubEnv.appIdSet && !J(pubEnv).includes('SRV-APP'))

// ---- where the SDK is ----
check('SDK folder: /opt/cctv/hcnetsdk/current unless CCTV_HIKSDK_DIR', hikSdkDir({}) === HIK_SDK_DEFAULT_DIR && hikSdkDir({ CCTV_HIKSDK_DIR: '/x/lib' }) === '/x/lib')
const ce = hikChildEnv({ LD_LIBRARY_PATH: '/usr/local/lib', PATH: '/bin' })
check('child env: the SDK folder and HCNetSDKCom first on the library path, the rest kept', ce.LD_LIBRARY_PATH === '/opt/cctv/hcnetsdk/current:/opt/cctv/hcnetsdk/current/HCNetSDKCom:/usr/local/lib' && ce.PATH === '/bin', ce.LD_LIBRARY_PATH)
check('child env: not doubled when already there', hikChildEnv(ce).LD_LIBRARY_PATH === ce.LD_LIBRARY_PATH)

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
