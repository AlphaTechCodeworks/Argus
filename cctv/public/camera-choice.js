// One camera picker for the Alarms page (the alarm filter, rules, motion tuning): grouped by site,
// each camera "3 · North Gate", offline ones last in a group of their own (or left out). The flat
// list it replaces had 73 entries, a dozen of them just "Eyeonet", and nothing to tell which site or
// channel each one was.

/** "3 · North Gate" (a camera the NVR has not named: "3 · Camera 3"). */
export const cameraLabel = (c) => `${c.ch + 1} · ${c.name || `Camera ${c.ch + 1}`}`

/** The cameras of one NVR, ascending by channel. `cameras` is the /api/cameras list. Pure. */
export function camerasForNvr(cameras, nvrId) {
  return (cameras ?? []).filter((c) => c.nvr === nvrId).sort((a, b) => a.ch - b.ch)
}

/**
 * The cameras as groups, in the order the server lists them (site, NVR, channel). A site with more
 * than one NVR gets a group per NVR, or channel numbers would repeat inside one group. Pure.
 * @param {{ nvr: string, ch: number, name?: string, site?: string, nvrName?: string, online?: boolean }[]} cameras
 * @returns {{ label: string, items: { value: string, label: string }[] }[]}
 */
export function cameraGroups(cameras, { onlineOnly = false } = {}) {
  const nvrsOfSite = new Map()
  for (const c of cameras) {
    const site = c.site || c.nvr
    if (!nvrsOfSite.has(site)) nvrsOfSite.set(site, new Set())
    nvrsOfSite.get(site).add(c.nvr)
  }
  const groupOf = (c) => {
    const site = c.site || c.nvr
    return nvrsOfSite.get(site).size > 1 ? `${site} · ${c.nvrName || c.nvr}` : site
  }
  const groups = new Map()
  const offline = []
  for (const c of cameras) {
    const item = { value: `${c.nvr}/${c.ch}`, label: cameraLabel(c) }
    if (c.online === false) {
      if (!onlineOnly) offline.push({ ...item, label: `${groupOf(c)} · ${item.label}` })
      continue
    }
    const g = groupOf(c)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(item)
  }
  const out = [...groups].map(([label, items]) => ({ label, items }))
  if (offline.length) out.push({ label: 'Offline', items: offline })
  return out
}

/** Appends the grouped cameras to a <select> (after whatever it already holds, e.g. "any"). */
export function fillCameraSelect(select, cameras, opts) {
  for (const g of cameraGroups(cameras, opts)) {
    const og = document.createElement('optgroup')
    og.label = g.label
    for (const i of g.items) og.append(new Option(i.label, i.value))
    select.append(og)
  }
}
