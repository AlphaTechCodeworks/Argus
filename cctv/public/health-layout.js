import { healthConnection, healthIssue } from './health-layout-model.js'

let search = ''
let issuesOnly = false
let selected = null
let activeFilter = () => {}

export function enhanceHealth(panels, rawNvrs = [], canMaintain = false) {
  const host = document.getElementById('nvrs')
  if (!host) return
  if (!document.getElementById('healthFilters')) {
    const tools = document.createElement('div')
    tools.id = 'healthFilters'
    tools.className = 'health-filters'
    const input = document.createElement('input')
    input.type = 'search'
    input.placeholder = 'Search NVRs or sites'
    input.setAttribute('aria-label', 'Search NVRs or sites')
    const label = document.createElement('label')
    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    label.append(toggle, ' Issues only')
    tools.append(input, label)
    host.before(tools)
    input.addEventListener('input', () => { search = input.value.toLowerCase(); activeFilter() })
    toggle.addEventListener('change', () => { issuesOnly = toggle.checked; activeFilter() })
  }
  const records = new Map(rawNvrs.map((n) => [n.id, n]))
  const models = new Map(panels.map((n) => [n.id, n]))
  const issueCount = panels.filter(healthIssue).length
  const hero = document.getElementById('hero')
  if (hero?.classList.contains('ok') && issueCount) {
    hero.classList.replace('ok', 'warn')
    const title = hero.querySelector('strong')
    const note = hero.querySelector('.hp-hero-text > span')
    if (title) title.textContent = `${issueCount} NVR${issueCount === 1 ? '' : 's'} need attention`
    if (note) note.textContent = 'Connection, camera availability or recording-storage problems'
  }
  const rows = [...host.querySelectorAll('details.nvr-panel')]
  const sorted = rows.sort((a, b) => Number(healthIssue(models.get(b.dataset.id))) - Number(healthIssue(models.get(a.dataset.id))) || models.get(a.dataset.id).name.localeCompare(models.get(b.dataset.id).name))
  const head = document.createElement('div')
  head.className = 'health-columns'
  for (const title of ['NVR / Site', 'Connection', 'Cameras', 'Recording here', 'NVR storage', 'Last contact']) {
    const cell = document.createElement('span'); cell.textContent = title; head.append(cell)
  }
  host.prepend(head)
  for (const row of sorted) {
    const n = models.get(row.dataset.id)
    const raw = records.get(n.id) ?? {}
    const connection = healthConnection(n, raw)
    row.dataset.search = `${n.name} ${raw.site ?? ''} ${n.id}`.toLowerCase()
    row.dataset.issue = String(healthIssue(n))
    const summary = row.querySelector('summary')
    const values = [n.name, connection.text, n.glance.cameras.value,
      n.fields.find((f) => f.label === 'Recording here')?.value ?? 'Not reported',
      n.disks.value === 'not available' ? connection.text === 'Disconnected' || connection.text === 'Video only' ? 'Management unavailable' : 'Not reported' : n.disks.value,
      n.fields.find((f) => f.label === 'Last contact')?.value ?? 'Not reported']
    summary.replaceChildren(...values.map((value, index) => {
      const cell = document.createElement('span')
      cell.textContent = value
      cell.className = index === 1 ? `health-connection ${connection.state}` : ''
      if (index === 0 && raw.site && raw.site !== n.name) {
        const site = document.createElement('small'); site.textContent = raw.site; cell.append(site)
      }
      return cell
    }))
    summary.title = n.status.note ?? ''
    row.open = selected === n.id
    summary.addEventListener('click', (event) => {
      event.preventDefault()
      const opening = !row.open
      selected = opening ? n.id : null
      for (const other of rows) other.open = opening && other === row
    })
    const facts = row.querySelector('.nvr-facts')
    if (facts) {
      const children = [...facts.children]
      const groups = new Map()
      for (let i = 0; i < children.length; i += 2) {
        const label = children[i].textContent
        const category = ['Model', 'Firmware', 'Serial', 'Address'].includes(label) ? 'Device information' : ['Cameras', 'Recording here', 'Recording held', 'Disks read'].includes(label) ? 'Recording and storage' : 'Connection'
        if (!groups.has(category)) {
          const section = document.createElement('div'); section.className = 'health-detail-group'
          const heading = document.createElement('h3'); heading.textContent = category
          section.append(heading); groups.set(category, section)
        }
        const pair = document.createElement('div')
        pair.className = 'health-fact'
        pair.append(...children.slice(i, i + 2))
        groups.get(category).append(pair)
      }
      facts.replaceChildren(...groups.values())
    }
    for (const value of row.querySelectorAll('dd, .big, .note, .hp-sub')) {
      if (value.textContent === 'not available') {
        value.textContent = 'Not reported'; value.classList.remove('warn', 'bad')
        value.classList.add('health-not-reported')
      }
    }
    let maintenance = row.querySelector('.nvr-maintenance, .hp-maintenance, .hp-power, .nvr-power')
    if (!maintenance && canMaintain) {
      maintenance = document.createElement('div')
      maintenance.className = 'nvr-power'
      for (const [text, action] of [['Reboot NVR', 'reboot'], ['Shut down', 'shutdown']]) {
        const button = document.createElement('button')
        button.type = 'button'; button.textContent = text
        button.disabled = connection.text !== 'Connected'
        button.title = action === 'shutdown' ? 'Power off; requires someone on site to turn it back on' : 'Restart this NVR; video and recording will pause'
        button.addEventListener('click', async () => {
          const warning = action === 'shutdown' ? `Shut down ${n.name}? Someone must turn it back on at the site.` : `Reboot ${n.name}? Video and recording will pause while it restarts.`
          if (!confirm(warning)) return
          button.disabled = true
          try {
            const response = await fetch(`/api/admin/nvrs/${encodeURIComponent(n.id)}/power`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, confirm: true }) })
            const result = await response.json()
            if (!response.ok) throw new Error(result.error ?? 'Request failed')
            alert(result.message ?? 'Command sent')
          } catch (error) { alert(error.message) } finally { button.disabled = false }
        })
        maintenance.append(button)
      }
      row.append(maintenance)
    }
    if (maintenance) {
      maintenance.removeAttribute('style')
      const menu = document.createElement('details'); menu.className = 'health-maintenance'
      const title = document.createElement('summary'); title.textContent = 'Maintenance'
      maintenance.before(menu); menu.append(title, maintenance)
    }
    host.append(row)
  }
  let empty = document.getElementById('healthNoResults')
  if (!empty) { empty = document.createElement('p'); empty.id = 'healthNoResults'; empty.role = 'status'; host.after(empty) }
  function filter() {
    let count = 0
    for (const row of rows) {
      row.hidden = !search.split(/\s+/).filter(Boolean).every((term) => row.dataset.search.includes(term)) || (issuesOnly && row.dataset.issue !== 'true')
      if (!row.hidden) count++
    }
    empty.textContent = rows.length ? 'No matching NVRs' : 'No NVRs configured'
    empty.hidden = count > 0
  }
  activeFilter = filter
  filter()
}
