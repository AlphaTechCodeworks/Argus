// Tabs for any page whose <main> holds sections marked data-tab (id), data-tab-label and
// data-tab-help: one tab shown at a time, the tab kept in the address (#id) so a link or a reload
// lands on it. Several sections may share one tab id: they show together (the label and help are
// taken from the first). The same look as the Settings tabs (se-tabs in style.css).
const main = document.querySelector('main')
const sections = [...main.querySelectorAll(':scope > section[data-tab]')]
const tabs = []
for (const s of sections) if (!tabs.some((t) => t.id === s.dataset.tab)) tabs.push({ id: s.dataset.tab, label: s.dataset.tabLabel ?? s.dataset.tab, help: s.dataset.tabHelp ?? '' })
if (tabs.length > 1) {
  const bar = document.createElement('nav')
  bar.className = 'se-tabs'
  bar.setAttribute('aria-label', 'Sections')
  const help = document.createElement('p')
  help.className = 'se-tab-help'
  for (const t of tabs) {
    const a = document.createElement('a')
    a.href = `#${t.id}`
    a.textContent = t.label
    a.dataset.tab = t.id
    bar.append(a)
  }
  main.prepend(bar, help)
  const show = (id) => {
    const t = tabs.find((x) => x.id === id) ?? tabs[0]
    for (const a of bar.children) a.toggleAttribute('aria-current', a.dataset.tab === t.id)
    // (a section some script keeps hidden -- e.g. accounts for a non-admin -- stays hidden)
    for (const s of sections) s.classList.toggle('se-off', s.dataset.tab !== t.id)
    help.textContent = t.help
  }
  addEventListener('hashchange', () => show(location.hash.slice(1)))
  show(location.hash.slice(1))
}
