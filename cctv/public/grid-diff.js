// Live grid: which cameras a page shows, and what a camera-list refresh changes on it.
// Pure functions (no DOM), so viewer.js can update single tiles instead of rebuilding the
// whole grid (every picture blank and reconnecting) on each 30 s poll. Tested offline:
// test/grid-diff.test.mjs.

const key = (c) => `${c.nvr}/${c.ch}`

/**
 * Every camera the grid shows (on all its pages), in list order: the site filter and "Hide offline".
 * @param {{ site: string, online: boolean }[]} cameras
 * @param {{ site: string, hideOffline: boolean }} view
 */
export const shownCameras = (cameras, { site, hideOffline }) => cameras.filter((c) => (!site || c.site === site) && (c.online || !hideOffline))

/**
 * Cameras on the current page.
 * @param {{ nvr: string, site: string, ch: number, online: boolean }[]} cameras
 * @param {{ site: string, hideOffline: boolean, perPage: number, page: number }} view
 * @returns {{ visible: object[], pages: number, page: number }} page is clamped to the last page
 */
export function visibleCameras(cameras, { site, hideOffline, perPage, page }) {
  const shown = shownCameras(cameras, { site, hideOffline })
  const pages = Math.max(1, Math.ceil(shown.length / perPage))
  const p = Math.min(Math.max(page, 0), pages - 1)
  return { visible: shown.slice(p * perPage, (p + 1) * perPage), pages, page: p }
}

const siteCount = (cameras) => new Set(cameras.map((c) => c.site)).size

/**
 * What a new camera list changes on the page in view.
 * full: the grid has to be rebuilt (the cameras on the page or their order changed, the page
 * count changed, or the site prefix of the labels comes or goes).
 * changed: otherwise, the tiles to update: { index (tile position), cam (new entry),
 * online, name, remote (true when that field changed) }.
 */
export function diffCameras(oldList, newList, view) {
  const a = visibleCameras(oldList, view)
  const b = visibleCameras(newList, view)
  const full =
    oldList.length === 0 ||
    a.page !== b.page ||
    a.pages !== b.pages ||
    a.visible.length !== b.visible.length ||
    a.visible.some((c, i) => key(c) !== key(b.visible[i]) || c.site !== b.visible[i].site) ||
    (siteCount(oldList) > 1) !== (siteCount(newList) > 1)
  if (full) return { full: true, changed: [] }
  const changed = []
  b.visible.forEach((cam, index) => {
    const was = a.visible[index]
    const d = { online: was.online !== cam.online, name: was.name !== cam.name, remote: Boolean(was.remote) !== Boolean(cam.remote) }
    if (d.online || d.name || d.remote) changed.push({ index, cam, ...d })
  })
  return { full: false, changed }
}
