// Hikvision devices in data/nvrs.json, and where the SDK lives. Pure (no SDK, no koffi), so it is
// tested on any machine (test/hik-config.test.mjs).
//
// A Hikvision record sits in the same list as the TVT NVRs and has the same shape, plus brand:
//   { id, name, site, brand: 'hikvision', host, port (8000), user, password, remote?, p2p? }
// The password is kept exactly as a TVT NVR's is (nvrs.json, mode 0600, never sent back to a browser).
//
// p2p: Hik-Connect, through the SDK's NET_SDK_P2P_LOGIN_2C local setting (HCNetSDK.h 32037, structure
// NET_SDK_P2P_SERVER_2C at 32081: platform type, AppID, sign-in ("auth") server address, platform
// address, user name, password). None of it is in the developer guide, and none of the values can be
// guessed: they come from Hikvision with developer access. So it stays OFF until the AppID, both
// addresses and the platform type are filled in, for the device or for the whole server
// (CCTV_HIK_P2P_APPID, CCTV_HIK_P2P_AUTH_ADDR, CCTV_HIK_P2P_PLATFORM_ADDR, CCTV_HIK_P2P_PLATFORM_TYPE).
// Its secrets (the account password and the four developer values) are stored like the device
// password and never sent back; the page only learns whether each one is set.
import { join } from 'node:path'
import { HIK_DEFAULT_PORT } from './hik-structs.mjs'
import { P2P_NOT_SET_UP } from './hik-core.mjs'

export const HIK = 'hikvision'
export const isHik = (cfg) => cfg?.brand === HIK

/** Where the SDK is installed (deploy/install-hcnetsdk.sh): a stable link to the current version. */
export const HIK_SDK_DEFAULT_DIR = '/opt/cctv/hcnetsdk/current'
/** The SDK's lib directory (the one holding libhcnetsdk.so and HCNetSDKCom/): CCTV_HIKSDK_DIR or the installed copy. */
export const hikSdkDir = (env = process.env) => env.CCTV_HIKSDK_DIR || HIK_SDK_DEFAULT_DIR
/**
 * The environment for a process that loads the SDK: its own libraries (libhpr, libHCCore, ...) and the
 * HCNetSDKCom components on the library path, as the SDK's readme asks (doc/readme.txt). Only the
 * Hikvision child processes get it; the server and the TVT workers do not.
 */
export function hikChildEnv(env = process.env) {
  const dir = hikSdkDir(env)
  const extra = [dir, join(dir, 'HCNetSDKCom')].map((p) => p.replace(/\\/g, '/'))
  const now = env.LD_LIBRARY_PATH ? env.LD_LIBRARY_PATH.split(':').filter(Boolean) : []
  return { ...env, CCTV_HIKSDK_DIR: dir, LD_LIBRARY_PATH: [...extra, ...now.filter((p) => !extra.includes(p))].join(':') }
}

// ---- the device's own fields --------------------------------------------------------------------------

const P2P_SECRETS = ['password', 'appId', 'authAddr', 'platformAddr']
const P2P_DEV = ['appId', 'authAddr', 'platformAddr', 'platformType'] // what Hikvision gives with developer access
const ENV_KEYS = { appId: 'CCTV_HIK_P2P_APPID', authAddr: 'CCTV_HIK_P2P_AUTH_ADDR', platformAddr: 'CCTV_HIK_P2P_PLATFORM_ADDR', platformType: 'CCTV_HIK_P2P_PLATFORM_TYPE' }

const text = (input, key, max, { required = false, partial = false, label = key } = {}) => {
  if (input[key] === undefined) {
    if (required && !partial) throw new Error(`${label} is required`)
    return undefined
  }
  const v = String(input[key] ?? '').trim()
  if (required && !v) throw new Error(`${label} is required`)
  if (v.length > max) throw new Error(`${label} is too long`)
  return v
}

/** A platform type 0-255, or undefined for empty (the header's BYTE byPlatformType). */
const platformTypeOf = (v) => {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error('Hik-Connect platform type must be a whole number 0-255 (from Hikvision)')
  return n
}

/** An address as Hikvision gives it (a host name, host:port or a URL): printable, no spaces. */
const addressOf = (v, label) => {
  const s = String(v ?? '').trim()
  if (!s) return ''
  if (s.length > 255 || !/^[\x21-\x7e]+$/.test(s)) throw new Error(`${label}: no spaces, at most 255 characters`)
  return s
}

/**
 * Checks and normalises a Hikvision device's settings from the Sites page (the password is handled by
 * admin.mjs as for every NVR). partial: an edit, where missing fields keep their values.
 * @param {object} input the request body
 * @param {{ partial?: boolean, current?: object|null, env?: object }} [o]
 * @returns {object} the fields to store (brand always 'hikvision')
 */
export function cleanHikFields(input, { partial = false, current = null, env = process.env } = {}) {
  const out = { brand: HIK }
  for (const [key, max, label] of [['site', 64, 'Site'], ['name', 64, 'Name'], ['user', 64, 'User name']]) {
    const v = text(input, key, max, { required: true, partial, label })
    if (v !== undefined) out[key] = v
  }
  if (input.remote !== undefined) out.remote = input.remote === true
  if (input.sn) throw new Error('A Hikvision device is added by its address, not by a TVT serial number')
  if (input.host !== undefined || !partial) {
    const host = String(input.host ?? '').trim()
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new Error('Enter the device’s IP address or host name')
    out.host = host
  }
  if (input.port !== undefined || !partial) {
    const port = input.port === undefined || input.port === '' || input.port === null ? HIK_DEFAULT_PORT : Number(input.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1-65535')
    out.port = port
  }
  if (input.p2p !== undefined) out.p2p = cleanP2p(input.p2p, current?.p2p ?? null, env)
  return out
}

/**
 * The p2p block: { enabled, account, password, appId, authAddr, platformAddr, platformType }. A secret
 * left empty keeps the stored one; `clear: true` (or null) removes the whole block. Switching it on is
 * refused until the developer values are known (here or from the server's environment) and the account
 * is complete: nothing is guessed.
 */
export function cleanP2p(input, current, env = process.env) {
  if (input === null || input?.clear === true) return null
  if (typeof input !== 'object') throw new Error('Hik-Connect settings are not valid')
  const next = { ...(current ?? {}) }
  if (input.account !== undefined) {
    const a = String(input.account ?? '').trim()
    if (a.length > 128) throw new Error('Hik-Connect account is too long')
    next.account = a
  }
  if (input.password) {
    if (String(input.password).length > 128) throw new Error('Hik-Connect password is too long')
    next.password = String(input.password)
  }
  if (input.appId) {
    const s = String(input.appId).trim()
    if (s.length > 255 || !/^[\x21-\x7e]+$/.test(s)) throw new Error('Hik-Connect AppID: no spaces, at most 255 characters')
    next.appId = s
  }
  if (input.authAddr) next.authAddr = addressOf(input.authAddr, 'Hik-Connect sign-in server address')
  if (input.platformAddr) next.platformAddr = addressOf(input.platformAddr, 'Hik-Connect platform address')
  if (input.platformType !== undefined && input.platformType !== '') next.platformType = platformTypeOf(input.platformType)
  next.enabled = input.enabled === undefined ? next.enabled === true : input.enabled === true
  if (next.enabled) {
    const s = p2pState({ p2p: next }, env)
    if (s.state === 'needs-access') throw new Error(`${P2P_NOT_SET_UP}: fill in the AppID, both server addresses and the platform type Hikvision gave you before switching it on`)
    if (s.state === 'needs-account') throw new Error('Hik-Connect: enter the account (email or phone number) and its password')
  }
  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k]
  return next
}

/** The values the SDK would be given: the device's own, then the server's environment. Never invented. */
export function p2pSettings(cfg, env = process.env) {
  const p = cfg?.p2p ?? {}
  const fromEnv = (k) => {
    const v = env[ENV_KEYS[k]]
    if (v === undefined || v === '') return undefined
    return k === 'platformType' ? (() => { try { return platformTypeOf(v) } catch { return undefined } })() : String(v).trim()
  }
  const pick = (k) => (p[k] !== undefined && p[k] !== '' ? p[k] : fromEnv(k))
  return { enabled: p.enabled === true, account: p.account ?? '', password: p.password ?? '', appId: pick('appId'), authAddr: pick('authAddr'), platformAddr: pick('platformAddr'), platformType: pick('platformType') }
}

/**
 * Where Hik-Connect stands for a device: off (not switched on), needs-access (developer values
 * missing), needs-account (no account or password), ready (it will be tried; UNVERIFIED: no Hik-Connect
 * access was available to test it).
 */
export function p2pState(cfg, env = process.env) {
  const s = p2pSettings(cfg, env)
  const missing = P2P_DEV.filter((k) => s[k] === undefined || s[k] === '')
  if (missing.length) return { state: s.enabled ? 'needs-access' : 'off', message: P2P_NOT_SET_UP, missing }
  if (!s.enabled) return { state: 'off', message: 'Hik-Connect is switched off for this device', missing: [] }
  if (!s.account || !s.password) return { state: 'needs-account', message: 'Hik-Connect: the account or its password is missing', missing: [] }
  return { state: 'ready', message: 'Hik-Connect sign-in is set up (not yet proven against Hikvision’s service)', missing: [] }
}

/** What the Sites page may see of the p2p block: no secrets, only whether each is set. */
export function publicP2p(cfg, env = process.env) {
  const p = cfg?.p2p ?? {}
  const s = p2pSettings(cfg, env)
  const st = p2pState(cfg, env)
  const set = (k) => p[k] !== undefined && p[k] !== ''
  const server = (k) => !set(k) && s[k] !== undefined && s[k] !== ''
  return {
    enabled: p.enabled === true,
    account: p.account ?? '',
    passwordSet: set('password'),
    appIdSet: set('appId'), authAddrSet: set('authAddr'), platformAddrSet: set('platformAddr'), platformTypeSet: p.platformType !== undefined,
    // filled in for the whole server instead (environment)
    fromServer: { appId: server('appId'), authAddr: server('authAddr'), platformAddr: server('platformAddr'), platformType: server('platformType') },
    state: st.state,
    message: st.message
  }
}

/** Fields whose change means a new login (the worker is restarted). */
export const HIK_CONNECTION_KEYS = ['host', 'port', 'user', 'password', 'brand']
/** Whether the p2p block changed in a way the SDK would see. */
export const p2pChanged = (a, b) => JSON.stringify(a?.p2p ?? null) !== JSON.stringify(b?.p2p ?? null)
/** For tests and the secrets list. */
export const P2P_SECRET_KEYS = P2P_SECRETS
