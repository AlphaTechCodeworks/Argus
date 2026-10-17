import { isPhone } from './device.js'

/** One page-wide budget, including foreground upgrades and playback. */
export function createVideoBudget({ decoders = 9, imageBytes = 96 * 1024 ** 2 } = {}) {
  const owners = new Set()
  return {
    acquire(owner) {
      if (owners.has(owner)) return true
      if (owners.size >= decoders) return false
      owners.add(owner)
      return true
    },
    release(owner) { owners.delete(owner) },
    enforce() {
      const share = imageBytes / Math.max(1, owners.size)
      for (const owner of owners) owner.trimImages(share)
    },
    get active() { return owners.size },
    get limit() { return decoders }
  }
}
let phoneBudget
export function deviceVideoBudget(nav = globalThis.navigator) {
  if (!isPhone(nav)) return null
  phoneBudget ??= createVideoBudget({ decoders: nav.deviceMemory <= 2 ? 4 : 9,
    imageBytes: (nav.deviceMemory <= 2 ? 48 : 96) * 1024 ** 2 })
  return phoneBudget
}
