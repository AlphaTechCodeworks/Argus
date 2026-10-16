// Smoke test of the Hikvision SDK on a server (Linux, after deploy/install-hcnetsdk.sh): loads it the
// way a Hikvision worker does, checks the structure layouts, calls NET_DVR_Init, prints the SDK
// version (NET_DVR_GetSDKBuildVersion), tries one NET_DVR_Login_V40 to the address given and prints
// the result or the error text, logs out if it got in, and calls NET_DVR_Cleanup. Nothing is saved
// and the server is not involved; against an address with nothing on it, it proves the SDK loads and
// answers ("cannot connect", error 7). Each call's error code is read on the SDK thread that made the
// call, straight after it (hik-call-thread.mjs: the SDK keeps its last error per thread).
//
//   node cctv/tools/hik-smoke.mjs <address> [port=8000] [user=admin]      (password: HIK_PASS=..., else empty)
//   CCTV_HIKSDK_DIR=/path/to/sdk/lib node cctv/tools/hik-smoke.mjs ...      (another copy of the SDK)
//
// The SDK's own libraries must be on the library path before the process starts, so if they are not,
// this re-runs itself once with them added (hik-config.mjs hikChildEnv), as the server does for its
// Hikvision workers. Exit code: 0 the SDK loaded and answered (a refused login included), 1 it did not.
import { spawnSync } from 'node:child_process'
import { hikChildEnv, hikSdkDir } from '../hik-config.mjs'
import { errorText, loginErrorText, sdkVersionText } from '../hik-core.mjs'

const [host, portArg = '8000', user = 'admin'] = process.argv.slice(2)
if (!host) {
  console.error('usage: node cctv/tools/hik-smoke.mjs <address> [port=8000] [user=admin]   (password in HIK_PASS)')
  process.exit(2)
}
const port = Number(portArg)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`port ${portArg} is not 1-65535`)
  process.exit(2)
}

const dir = hikSdkDir()
if (process.env.CCTV_HIK_SMOKE_CHILD !== '1' && !(process.env.LD_LIBRARY_PATH ?? '').split(':').includes(dir)) {
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...hikChildEnv(), CCTV_HIK_SMOKE_CHILD: '1' } })
  process.exit(r.status ?? 1)
}

const { openHikSdk } = await import('../hik-sdk.mjs')
console.log(`SDK folder: ${dir}`)
const opened = await openHikSdk({ dir })
if (!opened.ok) {
  console.error(`not loaded: ${opened.why}`)
  process.exit(1)
}
console.log('loaded; structure layouts match the header transcription (hik-structs.mjs)')
const sdk = opened.sdk
const init = await sdk.init({}) // no log file: this is a one-off
if (!init.ok) {
  console.error(`NET_DVR_Init failed: ${init.why}`)
  process.exit(1)
}
for (const n of init.notes ?? []) console.log(`note: ${n}`)
const v = await sdk.version()
console.log(`NET_DVR_GetSDKBuildVersion: ${sdkVersionText(v)} (0x${(v >>> 0).toString(16).padStart(8, '0')})`)

console.log(`NET_DVR_Login_V40 to ${host}:${port} as ${user}...`)
const t0 = Date.now()
let code = 0
try {
  const r = await sdk.login({ host, port, user, password: process.env.HIK_PASS ?? '' })
  const ms = Date.now() - t0
  if (r.userId >= 0) {
    const dc = await sdk.deviceCfg(r.userId).catch(() => ({ ok: false }))
    console.log(`logged in after ${ms} ms: ${dc.ok ? `${dc.model} "${dc.name}"` : 'device config not read'}, serial ${r.info.serial || '?'}, ${r.info.analogChannels} analog + ${r.info.ipChannels} IP channels`)
    await sdk.logout(r.userId)
  } else {
    console.log(`login failed after ${ms} ms: error ${r.code}: ${loginErrorText(r.code, r.info)}`)
  }
} catch (e) {
  console.log(`login did not finish: ${e.message}`)
  code = 1
}
const cleaned = await sdk.cleanup()
console.log(`NET_DVR_Cleanup: ${cleaned.ok ? 'ok' : `failed (${cleaned.why ?? `error ${cleaned.code}: ${errorText(cleaned.code)}`})`}`)
await sdk.close()
process.exit(code)
