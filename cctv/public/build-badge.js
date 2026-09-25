// Shows which build is running, in every page's header.
//
// Each page already fetches /api/me for the user name, but they do it at different points in
// their own start-up, so this asks once more rather than threading a value through six pages.
// The answer is small and cached by the browser for the moment it matters.
//
// Without this there is no way to tell from the screen whether a deploy actually landed — which
// has already cost time chasing "fixed" behaviour that was never installed.

const el = document.getElementById('build')
if (el) {
  fetch('/api/me')
    .then((r) => (r.ok ? r.json() : null))
    .then((me) => {
      const b = me?.build
      if (!b) return
      // the version is what we talk about; the release stamp, on hover, is how two installs of the
      // same version are told apart
      el.textContent = typeof b === 'string' ? b : b.version
      el.title = typeof b === 'string' ? `Running ${b}` : `Running ${b.version}, installed ${b.release}`
    })
    .catch(() => {}) // a page that cannot reach the server has louder problems to report
}
