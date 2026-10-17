// Tests telling a phone from a PC (public/device.js).   node cctv/test/device.test.mjs
import { canvasSize, isLocalHost, isPhone, maxLiveFps } from '../public/device.js'

let failures = 0
const check = (n, ok) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`) }

check('Chrome on Android says it is mobile', isPhone({ userAgentData: { mobile: true }, userAgent: '' }))
check('Chrome on a PC says it is not', !isPhone({ userAgentData: { mobile: false }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }))
check('iPhone Safari (no userAgentData)', isPhone({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' }))
check('Android tablet is not a phone', !isPhone({ userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/129.0 Safari/537.36' }))
check('Firefox on Android', isPhone({ userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0' }))
check('iPad is not a phone', !isPhone({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' }))
check('touchscreen Windows laptop is not a phone', !isPhone({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0', maxTouchPoints: 10 }))
check('phones are held to 15 fps, PCs are not held', maxLiveFps({ userAgentData: { mobile: true } }) === 15 && maxLiveFps({ userAgentData: { mobile: false } }) === null)

const phone = { userAgentData: { mobile: true } }
const desktop = { userAgentData: { mobile: false } }
const tile = { width: 400, height: 225 }
const phoneTile = canvasSize(1920, 1080, tile, 3, phone)
check('dense phone tile uses a quarter of the previous canvas pixels', phoneTile.width === 600 && phoneTile.height === 337)
const full = canvasSize(3840, 2160, { width: 2400, height: 1350 }, 3, phone)
check('phone fullscreen surface stays within 720p', full.width === 1280 && full.height === 720)
const cheap = canvasSize(3840, 2160, { width: 2400, height: 1350 }, 3, { ...phone, deviceMemory: 2 })
check('low-memory phone uses at most a 540p surface', cheap.width === 960 && cheap.height === 540)
const pc = canvasSize(3840, 2160, { width: 1920, height: 1080 }, 2, desktop)
check('desktop retains its full-resolution surface', pc.width === 3840 && pc.height === 2160)
const small = canvasSize(320, 180, tile, 3, phone)
check('phone never upscales the source surface', small.width === 320 && small.height === 180)
const hidden = canvasSize(1920, 1080, { width: 0, height: 0 }, 3, phone)
check('hidden canvas has a minimal valid backing store', hidden.width === 2 && hidden.height === 2)

// ---- the page opened on the local network, or through the tunnel / the tailnet (isLocalHost) ----
// A remote page's live view gets the bigger playout buffer (playout.js REMOTE_CLOCK, viewer.js); a
// local one keeps live's own, exactly as it was.
const local = ['192.168.1.232', '10.0.0.5', '172.16.0.1', '172.31.255.254', '127.0.0.1', '169.254.10.1', 'localhost', 'LOCALHOST', 'localhost.', 'argus.localhost', '[::1]', '[fe80::1]', '[fd12:3456::1]', 'nvr-box.local', 'argus', 'argus.lan', 'argus.home.arpa', 'argus.internal', '', undefined]
for (const h of local) check(`local: ${JSON.stringify(h)}`, isLocalHost(h) === true)
const remote = ['cctv.jfl.gripe', 'cctv.jfl.gripe.', '100.101.102.103', 'argus.tail1234.ts.net', '8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.1.1', '11.0.0.1', '[2001:db8::1]', '[::100:1]', '[::ffff:808:808]', '256.1.1.1', 'local.example.com', '192.168.1.232.nip.io']
for (const h of remote) check(`remote: ${JSON.stringify(h)}`, isLocalHost(h) === false)
check('with no host named, the page\'s own (location.hostname)', (() => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'location')
  try {
    Object.defineProperty(globalThis, 'location', { value: { hostname: 'cctv.jfl.gripe' }, configurable: true })
    const tunnel = isLocalHost()
    globalThis.location.hostname = '192.168.1.232'
    return tunnel === false && isLocalHost() === true
  } finally {
    if (had) Object.defineProperty(globalThis, 'location', had)
    else delete globalThis.location
  }
})())

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
