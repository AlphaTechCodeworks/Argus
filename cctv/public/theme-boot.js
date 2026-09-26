// Sets the theme before the page paints, so a light-theme user never sees a flash of dark. It is a
// plain script rather than a module because modules run after first paint, which is exactly the
// flash this exists to prevent. Duplicates theme.js's key and rule on purpose: it cannot import.
try {
  if (localStorage.getItem('cctv.theme') === 'light') document.documentElement.dataset.theme = 'light'
} catch {}
