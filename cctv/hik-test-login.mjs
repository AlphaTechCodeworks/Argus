// "Test" for a Hikvision device on the Sites page: one login in a short-lived child process (the
// Hikvision SDK never loads in the server), which reports the device's model, serial and camera count,
// or the plain reason it failed, and exits. hik-nvr.mjs testHikLogin starts it.
//
// runTestLogin is the work itself, with the SDK passed in (test/hik-worker.test.mjs uses a fake).
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { channelsFrom, errorText, loginErrorText, sdkVersionText } from './hik-core.mjs'
import { hikSdkDir, p2pSettings, p2pState } from './hik-config.mjs'

/**
 * @param {{ sdk: object|null, sdkWhy?: string, fields: object, env?: object, logDir?: string }} o
 * @returns {Promise<{ ok: true, model: string, serial: string, name: string, cameras: number, channels: number, sdkVersion: string, p2p: object } | { ok: false, why: string, p2p?: object }>}
 */
export async function runTestLogin({ sdk, sdkWhy = '', fields, env = process.env, logDir }) {
  if (!sdk) return { ok: false, why: sdkWhy }
  const init = await sdk.init({ logDir }).catch((e) => ({ ok: false, why: e.message }))
  if (!init.ok) return { ok: false, why: `Hikvision support could not start: ${init.why}` }
  const sdkVersion = sdkVersionText(await sdk.version().catch(() => 0))
  // Hik-Connect sign-in, only when every value for it is there (hik-config.mjs p2pState). UNVERIFIED.
  const st = p2pState(fields, env)
  let p2p = { state: st.state, message: st.message }
  if (st.state === 'ready') {
    const r = await sdk.p2pLogin2C(p2pSettings(fields, env)).catch((e) => ({ ok: false, why: e.message }))
    p2p = r.ok
      ? { state: 'ready', signedIn: true, message: 'Hik-Connect sign-in was accepted by the SDK (unverified: whether it reaches the recorder through Hik-Connect is not documented; this test still logs in by address)' }
      : { state: 'ready', signedIn: false, message: `Hik-Connect sign-in failed: ${r.why ?? errorText(r.code)}` }
  }
  let r
  try {
    r = await sdk.login({ host: fields.host, port: Number(fields.port), user: fields.user, password: fields.password ?? '' })
  } catch (e) {
    return { ok: false, why: e.name === 'HikTimeout' ? 'the device did not answer in time' : e.message, p2p }
  }
  if (r.userId < 0) return { ok: false, why: loginErrorText(r.code, r.info ?? {}), p2p }
  try {
    const dc = await sdk.deviceCfg(r.userId).catch(() => ({ ok: false }))
    let ipcfg = null
    let note = ''
    if (r.info.ipChannels > 0) {
      const ip = await sdk.ipConfig(r.userId).catch((e) => ({ ok: false, why: e.message }))
      if (ip.ok) ipcfg = ip.buf
      else note = `IP channel list not read: ${ip.why ?? errorText(ip.code)}`
    }
    const list = channelsFrom(r.info, ipcfg)
    return {
      ok: true,
      model: (dc.ok && dc.model) || 'Hikvision device',
      name: (dc.ok && dc.name) || '',
      serial: r.info.serial || (dc.ok ? dc.serial : '') || '',
      channels: r.info.analogChannels + r.info.ipChannels,
      cameras: list.filter((c) => c.configured).length,
      sdkVersion,
      note,
      p2p
    }
  } finally {
    await sdk.logout(r.userId)
  }
}

// ---- the child process ----------------------------------------------------------------------------------
if (process.env.CCTV_HIK_TEST_CHILD === '1' && process.send) {
  process.once('message', async (fields) => {
    let out
    try {
      let sdk = null
      let sdkWhy = ''
      if (process.env.CCTV_HIK_FAKE_SDK) sdk = (await import(pathToFileURL(process.env.CCTV_HIK_FAKE_SDK).href)).default
      else {
        const { openHikSdk } = await import('./hik-sdk.mjs')
        const o = await openHikSdk({ dir: hikSdkDir() })
        if (o.ok) sdk = o.sdk
        else sdkWhy = o.why
      }
      const dataDir = process.env.DATA_DIR ?? join(import.meta.dirname, '..', 'data')
      out = await runTestLogin({ sdk, sdkWhy, fields, logDir: join(dataDir, 'hiksdk-log', 'test') })
    } catch (e) {
      out = { ok: false, why: e?.message ?? String(e) }
    }
    process.send(out, () => process.exit(0))
  })
}
