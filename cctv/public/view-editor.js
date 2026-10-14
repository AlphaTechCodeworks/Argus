// The Live page's view editor: the one dialog behind "New view…", "Edit view…" and "Save a copy…".
//
//   1. Cameras  — every camera this user may watch, by site (each site folds away), with a search;
//                 tick any cameras from any sites. They go onto the tiles in the order they were ticked.
//   2. Layout   — one of the Live page's own layouts, or "Draw my own…": a grid of 2 to 8 squares a
//                 side where dragging across squares joins them into one bigger tile and clicking a
//                 big tile splits it again (custom-layout.js).
//   3. Placing  — the layout with a camera on each tile: drag one tile onto another (or click one,
//                 then the other) to swap the two, so the camera that matters gets the big tile.
//   Share with everyone, for the owner's own views (views.mjs sharedViews).
//
// It edits a draft and hands it to onSave; what a view may be is grid-view.js checkView's business,
// and storing it is the page's (viewer.js putViews). The markup is index.html's #saveViewDlg.
import { MAX_VIEW_CAMERAS, CUSTOM_LAYOUT, searchCameras } from './grid-view.js'
import { CUSTOM_MAX_SIZE, CUSTOM_MIN_SIZE, bigAt, cellsOfGrid, mergeRect, resizeGrid, splitAt } from './custom-layout.js'

const gridArea = ([c, r, w, h]) => `${r} / ${c} / span ${h} / span ${w}`
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/**
 * @param {object} o
 * @param {HTMLDialogElement} o.dialog
 * @param {() => Array<object>} o.cameras the cameras this user may watch (GET /api/cameras)
 * @param {(cam: object) => string} o.keyOf "<nvr>/<ch>"
 * @param {Array<{ value: string, label: string }>} o.layouts the page's own layouts, in menu order
 * @param {(layout: string, custom: object|null, count: number) => { size: number, rows?: number, cells: number[][] }} o.cellsOf
 * @param {(draft: { name: string, cameras: string[], layout: string, custom?: object, shared: boolean }) => Promise<string|null>} o.onSave
 *        resolves to an error to show, or null when saved
 */
export function createViewEditor({ dialog, cameras, keyOf, layouts, cellsOf, onSave }) {
  const $ = (id) => dialog.querySelector(`#${id}`)
  const title = $('veTitle')
  const nameEl = $('viewName')
  const msg = $('viewMsg')
  const count = $('veCount')
  const search = $('veSearch')
  const pick = $('vePick')
  const layoutEl = $('veLayout')
  const drawBox = $('veDraw')
  const sizeEl = $('veSize')
  const drawGrid = $('veDrawGrid')
  const place = $('vePlace')
  const more = $('veMore')
  const shareRow = $('veShareRow')
  const share = $('veShare')
  const saveBtn = $('viewSave')

  let chosen = [] // camera keys, in tile order
  let custom = null // the drawing, while "Draw my own…" is chosen (and kept if the viewer goes back to it)
  let picked = -1 // the tile clicked first, waiting for the one to swap it with
  const openSites = new Set()

  layoutEl.replaceChildren(...layouts.map((l) => new Option(l.label, l.value)), new Option('Draw my own…', CUSTOM_LAYOUT))
  sizeEl.replaceChildren(...Array.from({ length: CUSTOM_MAX_SIZE - CUSTOM_MIN_SIZE + 1 }, (_, i) => {
    const n = CUSTOM_MIN_SIZE + i
    return new Option(`${n} × ${n}`, String(n))
  }))

  const byKey = () => new Map(cameras().map((c) => [keyOf(c), c]))
  const camText = (c) => (c ? `${c.ch + 1} · ${c.name}${c.online === false ? ' (offline)' : ''}` : 'Empty')
  const say = (text) => { msg.textContent = text ?? '' }

  // ---- 1. cameras ----
  function sites(list) {
    const out = new Map()
    for (const c of list) {
      const s = c.site || c.nvrName || 'Cameras'
      if (!out.has(s)) out.set(s, [])
      out.get(s).push(c)
    }
    return [...out]
  }

  function drawPicker() {
    const q = search.value.trim()
    const all = cameras()
    const shown = searchCameras(all, q)
    const chosenSet = new Set(chosen)
    pick.replaceChildren(...sites(shown).map(([site, cams]) => {
      const box = el('details', 've-site')
      box.open = q !== '' || openSites.has(site)
      box.addEventListener('toggle', () => (box.open ? openSites.add(site) : openSites.delete(site)))
      const head = el('summary')
      head.append(el('span', 've-site-name', site), el('span', 've-site-count'))
      head.querySelector('.ve-site-count').dataset.site = site
      const body = el('div', 've-site-body')
      const allBtn = el('button', 've-all', 'Tick all')
      allBtn.type = 'button'
      allBtn._keys = cams.map(keyOf) // (its label, Tick all or Untick all, is set by showCounts)
      allBtn.addEventListener('click', () => {
        const keys = cams.map(keyOf)
        const every = keys.every((k) => chosen.includes(k))
        if (every) chosen = chosen.filter((k) => !keys.includes(k))
        else {
          for (const k of keys) {
            if (chosen.includes(k)) continue
            if (chosen.length >= MAX_VIEW_CAMERAS) { say(`A view holds at most ${MAX_VIEW_CAMERAS} cameras, so not all of them could be ticked.`); break }
            chosen.push(k)
          }
        }
        for (const cb of body.querySelectorAll('input[type=checkbox]')) cb.checked = chosen.includes(cb.value)
        changed()
      })
      body.append(allBtn)
      // with several NVRs on a site, say which one: two "Gate" cameras are otherwise one name twice
      const nvrs = new Set(all.filter((c) => (c.site || c.nvrName || 'Cameras') === site).map((c) => c.nvr)).size
      for (const c of cams) {
        const row = el('label', `ve-cam${c.online === false ? ' off' : ''}`)
        const box = el('input')
        box.type = 'checkbox'
        box.value = keyOf(c)
        box.checked = chosenSet.has(box.value)
        box.addEventListener('change', () => tick(box))
        row.append(box, el('span', '', `${camText(c)}${nvrs > 1 ? ` — ${c.nvrName ?? c.nvr}` : ''}`))
        body.append(row)
      }
      box.append(head, body)
      return box
    }))
    if (!shown.length) pick.append(el('p', 'live-help', q ? 'No camera matches.' : 'You have no cameras to choose from.'))
    showCounts()
  }

  function tick(box) {
    if (box.checked) {
      if (chosen.length >= MAX_VIEW_CAMERAS) {
        box.checked = false
        return say(`A view holds at most ${MAX_VIEW_CAMERAS} cameras. Untick one to add another.`)
      }
      if (!chosen.includes(box.value)) chosen.push(box.value)
    } else chosen = chosen.filter((k) => k !== box.value)
    changed()
  }

  function showCounts() {
    count.textContent = chosen.length
      ? `${chosen.length} ${chosen.length === 1 ? 'camera' : 'cameras'} chosen${chosen.length >= MAX_VIEW_CAMERAS ? ' (the most a view can hold)' : ''}`
      : 'No cameras chosen yet: tick the ones you want, from any site.'
    const keys = byKey()
    const per = new Map()
    for (const k of chosen) {
      const c = keys.get(k)
      const s = c ? c.site || c.nvrName || 'Cameras' : ''
      per.set(s, (per.get(s) ?? 0) + 1)
    }
    for (const span of pick.querySelectorAll('.ve-site-count')) {
      const n = per.get(span.dataset.site) ?? 0
      span.textContent = n ? `${n} chosen` : ''
    }
    for (const b of pick.querySelectorAll('.ve-all')) b.textContent = b._keys.every((k) => chosen.includes(k)) ? 'Untick all' : 'Tick all'
  }

  function changed() {
    picked = -1
    showCounts()
    drawPlace()
  }

  // ---- 2. layout ----
  /** The shape a layout id has, as a drawing to start from: its grid and its big tiles. */
  function shapeOf(layout) {
    const { size, rows = size, cells } = cellsOf(layout, null, Math.max(1, chosen.length))
    if (rows !== size || size < CUSTOM_MIN_SIZE || size > CUSTOM_MAX_SIZE) return { size: 3, big: [] }
    return { size, big: cells.filter(([, , w, h]) => w * h > 1) }
  }

  let lastLayout = 'auto'
  layoutEl.addEventListener('change', () => {
    if (layoutEl.value === CUSTOM_LAYOUT && !custom) custom = shapeOf(lastLayout)
    if (layoutEl.value !== CUSTOM_LAYOUT) lastLayout = layoutEl.value
    showDraw()
    drawPlace()
  })
  sizeEl.addEventListener('change', () => {
    custom = resizeGrid(custom, Number(sizeEl.value))
    showDraw()
    drawPlace()
  })

  function showDraw() {
    const on = layoutEl.value === CUSTOM_LAYOUT
    drawBox.hidden = !on
    if (!on) return
    sizeEl.value = String(custom.size)
    drawGrid.style.gridTemplateColumns = `repeat(${custom.size}, 1fr)`
    drawGrid.style.gridTemplateRows = `repeat(${custom.size}, 1fr)`
    const tiles = cellsOfGrid(custom).map((cell) => {
      const big = cell[2] * cell[3] > 1
      const t = el('div', big ? 've-draw-tile ve-big' : 've-draw-tile', big ? 'Big tile · click to split' : '')
      t.style.gridArea = gridArea(cell)
      return t
    })
    drawGrid.replaceChildren(...tiles, selBox)
    selBox.hidden = true
  }

  // Drag across squares to join them. Worked out from where the pointer is over the grid, not from
  // which element it is on, so a big tile, a gap or a finger all behave the same.
  const selBox = el('div', 've-draw-sel')
  let from = null
  const cellAt = (e) => {
    const r = drawGrid.getBoundingClientRect()
    const at = (v, start, len) => Math.min(custom.size, Math.max(1, Math.floor(((v - start) / len) * custom.size) + 1))
    return [at(e.clientX, r.left, r.width), at(e.clientY, r.top, r.height)]
  }
  const showSel = (a, b) => {
    selBox.hidden = false
    selBox.style.gridArea = gridArea([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]) + 1, Math.abs(a[1] - b[1]) + 1])
  }
  drawGrid.addEventListener('pointerdown', (e) => {
    if (!custom || e.button > 0) return
    e.preventDefault()
    from = cellAt(e)
    drawGrid.setPointerCapture?.(e.pointerId)
    showSel(from, from)
  })
  drawGrid.addEventListener('pointermove', (e) => { if (from) showSel(from, cellAt(e)) })
  const finish = (e) => {
    if (!from) return
    const to = cellAt(e)
    const start = from
    from = null
    say('')
    if (start[0] === to[0] && start[1] === to[1]) {
      if (bigAt(custom, ...to) >= 0) custom = splitAt(custom, ...to)
    } else {
      const { grid, error } = mergeRect(custom, start, to)
      custom = grid
      if (error) say(error)
    }
    showDraw()
    drawPlace()
  }
  drawGrid.addEventListener('pointerup', finish)
  drawGrid.addEventListener('pointercancel', () => { from = null; selBox.hidden = true })

  // ---- 3. placing the cameras ----
  function swap(a, b) {
    if (a === b || a < 0 || b < 0 || a >= chosen.length || b >= chosen.length) return
    ;[chosen[a], chosen[b]] = [chosen[b], chosen[a]]
  }
  /** A tile (or a chip on a later page) that can be dragged onto another, or clicked then clicked. */
  function placeable(node, i) {
    node.dataset.pos = String(i)
    if (i >= chosen.length) return node
    node.draggable = true
    node.tabIndex = 0
    node.classList.toggle('picked', picked === i)
    node.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move' })
    node.addEventListener('click', () => choose(i))
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(i) } })
    return node
  }
  const choose = (i) => {
    if (picked < 0) picked = i
    else { swap(picked, i); picked = -1 }
    drawPlace()
  }
  for (const box of [place, more]) {
    box.addEventListener('dragover', (e) => { if (e.target.closest('[data-pos]')) e.preventDefault() })
    box.addEventListener('drop', (e) => {
      const to = e.target.closest('[data-pos]')
      if (!to) return
      e.preventDefault()
      picked = -1
      swap(Number(e.dataTransfer.getData('text/plain')), Number(to.dataset.pos))
      drawPlace()
    })
  }

  function drawPlace() {
    const layout = layoutEl.value
    const { size, rows = size, cells } = cellsOf(layout, layout === CUSTOM_LAYOUT ? custom : null, Math.max(1, chosen.length))
    const keys = byKey()
    place.style.gridTemplateColumns = `repeat(${size}, 1fr)`
    place.style.gridTemplateRows = `repeat(${rows}, 1fr)`
    place.dataset.size = String(size)
    place.replaceChildren(...cells.map((cell, i) => {
      const t = el('div', `ve-place-tile${i < chosen.length ? '' : ' empty'}`, i < chosen.length ? camText(keys.get(chosen[i])) : 'Empty')
      if (i < chosen.length) t.title = 'Drag onto another tile to swap, or click this and then the other'
      t.style.gridArea = gridArea(cell)
      return placeable(t, i)
    }))
    const rest = chosen.slice(cells.length)
    more.replaceChildren()
    if (rest.length) {
      more.append(el('span', 'live-help', `On the next ${rest.length > cells.length ? 'pages' : 'page'} (use ‹ › on Live):`))
      rest.forEach((k, j) => more.append(placeable(el('span', 've-chip', camText(keys.get(k))), cells.length + j)))
    }
  }

  // ---- open, save ----
  /**
   * @param {{ title: string, view: { name?: string, cameras?: string[], layout?: string, custom?: object, shared?: boolean },
   *           canShare?: boolean }} o
   */
  function open({ title: heading, view, canShare = true }) {
    title.textContent = heading
    nameEl.value = view.name ?? ''
    search.value = ''
    const known = byKey()
    chosen = (view.cameras ?? []).filter((k) => known.has(k)).slice(0, MAX_VIEW_CAMERAS)
    const gone = (view.cameras ?? []).length - chosen.length
    say(gone > 0 ? `${gone} ${gone === 1 ? 'camera' : 'cameras'} of this view ${gone === 1 ? 'is' : 'are'} no longer available to you and ${gone === 1 ? 'was' : 'were'} left out.` : '')
    const wanted = view.layout === CUSTOM_LAYOUT || layouts.some((l) => l.value === view.layout) ? view.layout : 'auto'
    custom = view.layout === CUSTOM_LAYOUT && view.custom ? { size: view.custom.size, big: view.custom.big.map((b) => [...b]) } : null
    layoutEl.value = wanted
    lastLayout = wanted === CUSTOM_LAYOUT ? 'auto' : wanted
    openSites.clear()
    // the sites the view already uses start open; with only one site it is open anyway
    for (const k of chosen) { const c = known.get(k); if (c) openSites.add(c.site || c.nvrName || 'Cameras') }
    if (sites(cameras()).length === 1) openSites.add(sites(cameras())[0][0])
    shareRow.hidden = !canShare
    share.checked = canShare && view.shared === true
    picked = -1
    saveBtn.disabled = false
    drawPicker()
    showDraw()
    drawPlace()
    dialog.showModal()
    nameEl.focus()
  }

  search.addEventListener('input', drawPicker)
  $('veClear').addEventListener('click', () => {
    chosen = []
    for (const box of pick.querySelectorAll('input[type=checkbox]')) box.checked = false
    say('')
    changed()
  })

  saveBtn.addEventListener('click', async () => {
    if (chosen.length === 0) return say('Tick at least one camera.')
    const layout = layoutEl.value
    const draft = { name: nameEl.value, cameras: [...chosen], layout, shared: !shareRow.hidden && share.checked }
    if (layout === CUSTOM_LAYOUT) draft.custom = custom
    saveBtn.disabled = true
    const error = await onSave(draft).catch((e) => e?.message ?? 'The view could not be saved')
    saveBtn.disabled = false
    if (error) return say(error)
    dialog.close()
  })

  return { open }
}
