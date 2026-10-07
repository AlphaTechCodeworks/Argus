// Settings > Remote sites: say whether the site-server installer is on this server, and reveal the
// download when it is. The installer carries a tailnet key, so it is not shipped with the app — an
// admin builds it and places it on the server (connector-download.mjs). Admins see this page.
const link = document.getElementById('conn-download')
const status = document.getElementById('conn-status')

if (link && status) {
  fetch('/api/admin/connector')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((s) => {
      if (s.available) {
        const mb = (s.bytes / 1_048_576).toFixed(1)
        const when = s.mtime ? new Date(s.mtime).toLocaleString() : ''
        status.textContent = `Installer ready (${mb} MB${when ? `, built ${when}` : ''}).`
        link.hidden = false
      } else {
        status.textContent = 'No installer has been placed on this server yet. Build it (build.ps1 -AuthKey …) and copy it to the server’s data folder under connector/.'
        link.hidden = true
      }
    })
    .catch(() => {
      status.textContent = 'Could not check for the installer.'
      link.hidden = true
    })
}
