// Tests telling a phone from a PC (public/device.js).   node cctv/test/device.test.mjs
import { isPhone, maxLiveFps } from '../public/device.js'

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

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
