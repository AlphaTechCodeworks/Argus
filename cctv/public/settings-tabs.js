// Settings, one subject at a time: the page's sections are grouped into tabs (each section says
// which with data-tab) and only the chosen tab's are shown. The tab is in the address
// (settings.html#storage), so a link or a reload lands on it. Nothing about the forms themselves
// changes: every section still lives in the page and settings.js still fills them all.
const TABS = [
  { id: 'recording', label: 'Recording', help: 'What each camera records, and how long it is kept.' },
  { id: 'storage', label: 'Storage', help: 'Where recordings are written: drives, network shares, and when old footage is cleared.' },
  { id: 'overlay', label: 'On-screen text', help: 'The camera name and the time drawn over the picture.' },
  { id: 'alerts', label: 'Alerts', help: 'Who is told when something goes wrong, and how.' }
]

const main = document.querySelector('.st-main')
const sections = [...document.querySelectorAll('.se-section[data-tab]')]
const bar = document.createElement('nav')
bar.className = 'se-tabs'
bar.setAttribute('aria-label', 'Settings')
const help = document.createElement('p')
help.className = 'se-tab-help'
bar.append(...TABS.map((t) => {
  const a = document.createElement('a')
  a.href = `#${t.id}`
  a.textContent = t.label
  a.dataset.tab = t.id
  return a
}))
main.querySelector('#notice')?.after(bar, help)

function show(id) {
  const tab = TABS.find((t) => t.id === id) ?? TABS[0]
  for (const a of bar.children) a.toggleAttribute('aria-current', a.dataset.tab === tab.id)
  for (const s of sections) s.classList.toggle('se-off', s.dataset.tab !== tab.id)
  help.textContent = tab.help
}
addEventListener('hashchange', () => show(location.hash.slice(1)))
show(location.hash.slice(1))
