// Reveals the admin-only tabs in the header.
//
// Every page already unhides Sites and Settings for an admin, but each does it in its own way at
// its own moment, usually inside whatever else that page does on load. Adding two more tab names
// to six different places is how one page quietly ends up missing a tab -- and a tab that exists
// on nine pages and not the tenth reads as a bug in the tenth.
//
// So this asks once and unhides whatever admin tabs the page happens to carry. It is additive:
// the existing per-page logic still runs and still works, and a tab this does not know about is
// simply left alone. Nothing here grants anything -- the tab is a link, and every route behind it
// checks rights for itself. Hiding it only saves an admin-less user from a page that would refuse
// them anyway.
const TABS = ['sitesTab', 'settingsTab', 'storageTab', 'auditTab']

try {
  const res = await fetch('/api/me', { credentials: 'same-origin' })
  if (res.ok) {
    const me = await res.json()
    if (me?.admin) {
      for (const id of TABS) {
        const el = document.getElementById(id)
        if (el) el.hidden = false
      }
    }
  }
} catch {
  // Not being able to ask leaves the tabs hidden, which is the harmless way to be wrong: the
  // pages are still reachable by address, and a header that fails to load must not take the page
  // down with it.
}
