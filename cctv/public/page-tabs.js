// Tabs for any page whose <main> holds sections marked data-tab (id), data-tab-label and
// data-tab-help: one section shown at a time, the tab kept in the address (#id) so a link or a
// reload lands on it. The same look as the Settings tabs (se-tabs in style.css).
const main = document.querySelector('main')
const sections = [...main.querySelectorAll(':scope > section[data-tab]')]
if (sections.length > 1) {
  const bar = document.createElement('nav')
  bar.className = 'se-tabs'
  bar.setAttribute('aria-label', 'Sections')
  const help = document.createElement('p')
  help.className = 'se-tab-help'
  for (const s of sections) {
    const a = document.createElement('a')
    a.href = `#${s.dataset.tab}`
    a.textContent = s.dataset.tabLabel ?? s.dataset.tab
    a.dataset.tab = s.dataset.tab
    bar.append(a)
  }
  main.prepend(bar, help)
  const show = (id) => {
    const s = sections.find((x) => x.dataset.tab === id) ?? sections[0]
    for (const a of bar.children) a.toggleAttribute('aria-current', a.dataset.tab === s.dataset.tab)
    for (const x of sections) x.hidden = x !== s
    help.textContent = s.dataset.tabHelp ?? ''
  }
  addEventListener('hashchange', () => show(location.hash.slice(1)))
  show(location.hash.slice(1))
}
