// Where every page lives and who may see it, in one place.
//
// The ten links used to be typed out by hand in every page's HTML, and the copies drifted: one page
// grew a duplicate Storage tab, another lost Audit. Pure and DOM-free, so the rules are tested with
// plain node; shell.js does the drawing.

/** Grouped as the sidebar shows them. `icon` names a symbol in icons.js. */
export const NAV_GROUPS = Object.freeze([
  { id: 'watch', label: 'Watch', adminOnly: false, items: [
    { id: 'live', label: 'Live', href: '/', icon: 'live' },
    { id: 'playback', label: 'Playback', href: '/playback.html', icon: 'playback' },
    { id: 'map', label: 'Map', href: '/map.html', icon: 'map', needsMap: true }
  ] },
  { id: 'monitor', label: 'Monitor', adminOnly: false, items: [
    { id: 'alarms', label: 'Alarms', href: '/alarms.html', icon: 'bell' },
    { id: 'health', label: 'Health', href: '/health.html', icon: 'pulse' }
  ] },
  { id: 'admin', label: 'Admin', adminOnly: true, items: [
    // each admin link carries the capability (rights.mjs CAPS) it needs; a full admin holds all of
    // them. `cap` may be a list when more than one area reaches the page (Users & access also holds
    // the audit log). The server still checks every route — hiding a link only spares a dead end.
    { id: 'audit', label: 'Users & access', href: '/audit.html', icon: 'people', cap: ['users', 'audit'] },
    { id: 'sites', label: 'Sites', href: '/sites.html', icon: 'site', cap: 'cameras' },
    { id: 'settings', label: 'Settings', href: '/settings.html', icon: 'cog', cap: 'settings' },
    { id: 'storage', label: 'Storage', href: '/settings.html#storage', icon: 'disk', cap: 'storage' },
    { id: 'reports', label: 'Reports', href: '/reports.html', icon: 'chart', cap: 'reports' },
    { id: 'cameras', label: 'Cameras', href: '/cameras.html', icon: 'list', cap: 'cameras' },
    { id: 'register', label: 'NVR register', href: '/register.html', icon: 'list', cap: 'cameras' }
  ] }
])

/** The four a phone shows along the bottom; everything else is under More. */
export const PHONE_BAR = Object.freeze(['live', 'playback', 'alarms', 'health'])

/**
 * The groups and items this person may see. Hiding the admin pages grants and takes nothing -- every
 * route behind them checks rights for itself -- it only spares someone links to pages that would
 * refuse them. A full admin sees every admin link; a partial admin sees only the links whose
 * capability (`cap`) they hold, and the Admin group disappears when none remain; anyone not
 * positively an admin of some kind is treated as a viewer.
 */
export function navFor({ admin = false, adminCaps = [], map = true } = {}) {
  const has = (cap) => admin === true || (Array.isArray(adminCaps) && adminCaps.includes(cap))
  // an item is shown when its capability (if any) is held, and, for the Map, when the Map is not
  // turned off for this person (a full admin always sees it)
  const mayItem = (i) =>
    (!i.cap || (Array.isArray(i.cap) ? i.cap.some(has) : has(i.cap))) &&
    (!i.needsMap || admin === true || map !== false)
  return NAV_GROUPS.map((g) => {
    const items = g.items.filter(mayItem)
    if (g.adminOnly) return items.length ? { ...g, items } : null
    return { ...g, items }
  }).filter(Boolean)
}

/** Which item a page path belongs to, or null for pages outside the navigation. */
export function currentId(pathname) {
  const path = String(pathname ?? '').split(/[?#]/)[0]
  const p = path === '/index.html' ? '/' : path
  for (const g of NAV_GROUPS) for (const i of g.items) if (i.href === p) return i.id
  return null
}
