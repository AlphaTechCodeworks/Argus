// Whether this is a phone rather than a PC, laptop or tablet. The browser says so itself where it
// can (navigator.userAgentData.mobile, Chrome and Edge); otherwise every phone browser names itself
// in its user agent. A touch screen alone is not enough: touchscreen laptops have one too.
export function isPhone(nav = globalThis.navigator) {
  if (!nav) return false
  if (typeof nav.userAgentData?.mobile === 'boolean') return nav.userAgentData.mobile
  const ua = String(nav.userAgent ?? '')
  return /iPhone|iPod|Android.*Mobile|Mobile.*Firefox|Windows Phone/i.test(ua)
}

/** The most frames a second worth drawing here: a phone's small screen gains nothing above 15. */
export const maxLiveFps = (nav) => (isPhone(nav) ? 15 : null)
