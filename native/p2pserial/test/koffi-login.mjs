// The add-on loaded the way the app loads it: koffi.load(.., { global: true }) before the SDK, no
// LD_PRELOAD (test.sh). Offline: the P2P server must be a documentation address, so the login
// fails after about 20 s with error 8; P2P_SERIAL_LOG=1 shows which device code reached the NAT
// library. Must sit under /app in the app image, so that 'koffi' resolves to /app/node_modules.
//   node koffi-login.mjs ADDON SDK HOST PORT SERIAL [--no-add] [--load-only]
import koffi from 'koffi'

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const [addonPath, sdkPath, host, port, serial] = args.filter((a) => !a.startsWith('--'))
if (!/^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/.test(host ?? '')) throw new Error('offline test only: the P2P server must be a documentation address')

const addon = koffi.load(addonPath, { global: true })
if (!flags.has('--no-add')) {
  const add = addon.func('int p2pserial_add(str serial)')
  const count = addon.func('int p2pserial_count()')
  const r = add(serial)
  console.log(`p2pserial_add(${serial}) -> ${r}, count ${count()}`)
}
const sdk = koffi.load(sdkPath)
if (flags.has('--load-only')) {
  console.log(`loaded ${sdkPath}`)
  process.exit(0)
}

const Init = sdk.func('bool NET_SDK_Init()')
const Cleanup = sdk.func('bool NET_SDK_Cleanup()')
const SetNat2Addr = sdk.func('bool NET_SDK_SetNat2Addr(str addr, uint16 port)')
const LoginEx = sdk.func('long NET_SDK_LoginEx(str ip, uint16 port, str user, str pass, void *info, int type, str sn)')
const GetLastError = sdk.func('uint32 NET_SDK_GetLastError()')

console.log(`NET_SDK_Init -> ${Number(Init())}`)
console.log(`NET_SDK_SetNat2Addr(${host}, ${port}) -> ${Number(SetNat2Addr(host, Number(port)))}`)
const info = Buffer.alloc(4096)
const t0 = Date.now()
// on a libuv worker thread, as the app's sdkCall() does
const id = await new Promise((resolve, reject) => LoginEx.async(host, Number(port), 'offline', 'offline', info, 2, serial, (err, r) => (err ? reject(err) : resolve(r))))
console.log(`NET_SDK_LoginEx -> ${id} after ${((Date.now() - t0) / 1000).toFixed(1)} s, last error ${GetLastError()}`)
const t1 = Date.now()
const ok = Cleanup()
console.log(`NET_SDK_Cleanup -> ${Number(ok)} after ${((Date.now() - t1) / 1000).toFixed(1)} s`)
