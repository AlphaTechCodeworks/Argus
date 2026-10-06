// The public clip-share landing page. Reads the token from the URL, asks /s/<token>/info, and shows
// the clip's details with a Download button -- or a plain "no longer valid" for a bad token. No
// account, nothing but this one clip. The pure render mapping (view) is exported for tests.

/** What the page shows for a /s/<token>/info answer. ok:false (bad token) -> a plain message. */
export function view(info) {
  if (!info || info.ok !== true) return { ok: false, message: 'This link has expired or is no longer valid.' }
  const expires = Number.isFinite(info.expiresAt) ? new Date(info.expiresAt) : null
  return {
    ok: true,
    label: (typeof info.label === 'string' && info.label) || 'Evidence clip',
    when: (typeof info.when === 'string' && info.when) || null,
    format: ((typeof info.format === 'string' ? info.format : '') || '').toUpperCase() || null,
    expires: expires ? expires.toLocaleString() : null
  }
}

const tokenFromUrl = () => (location.pathname.match(/^\/s\/([A-Za-z0-9_-]{1,64})/) || [])[1] ?? ''

async function render() {
  const box = document.getElementById('share-body')
  if (!box) return
  const t = tokenFromUrl()
  const info = await fetch(`/s/${encodeURIComponent(t)}/info`).then((r) => r.json()).catch(() => ({ ok: false }))
  const v = view(info)
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props)
  box.replaceChildren()
  if (!v.ok) {
    box.append(el('p', { className: 'st-error', textContent: v.message }))
    return
  }
  box.append(el('p', { className: 'share-label', textContent: v.label }))
  if (v.when) box.append(el('p', { className: 'st-meta', textContent: v.when }))
  const meta = [v.format ? `Format: ${v.format}` : null, v.expires ? `Link expires ${v.expires}` : null].filter(Boolean).join(' · ')
  if (meta) box.append(el('p', { className: 'st-meta', textContent: meta }))
  const dl = el('a', { className: 'st-primary share-download', href: `/s/${encodeURIComponent(t)}/download`, textContent: 'Download clip' })
  dl.setAttribute('download', '')
  box.append(dl)
}

if (typeof document !== 'undefined') render()
