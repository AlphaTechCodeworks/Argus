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
    { id: 'map', label: 'Map', href: '/map.html', icon: 'map' }
  ] },
  { id: 'monitor', label: 'Monitor', adminOnly: false, items: [
    { id: 'alarms', label: 'Alarms', href: '/alarms.html', icon: 'bell' },
    { id: 'health', label: 'Health', href: '/health.html', icon: 'pulse' }
  ] },
  { id: 'admin', label: 'Admin', adminOnly: true, items: [
    { id: 'sites', label: 'Sites', href: '/sites.html', icon: 'site' },
    { id: 'settings', label: 'Settings', href: '/settings.html', icon: 'cog' },
    { id: 'storage', label: 'Storage', href: '/settings.html#storage', icon: 'disk' },
    { id: 'audit', label: 'Users & audit', href: '/audit.html', icon: 'list' }
  ] }
])

/** The four a phone shows along the bottom; everything else is under More. */
export const PHONE_BAR = Object.freeze(['live', 'playback', 'alarms', 'health'])

/**
 * The groups this person may see. Hiding the admin pages grants and takes nothing -- every route
 * behind them checks rights for itself -- it only spares a viewer links to pages that would refuse
 * them. Anyone not positively an admin is treated as a viewer.
 */
export function navFor({ admin = false } = {}) {
  return NAV_GROUPS.filter((g) => !g.adminOnly || admin === true)
}

/** Which item a page path belongs to, or null for pages outside the navigation. */
export function currentId(pathname) {
  const path = String(pathname ?? '').split(/[?#]/)[0]
  const p = path === '/index.html' ? '/' : path
  for (const g of NAV_GROUPS) for (const i of g.items) if (i.href === p) return i.id
  return null
}
