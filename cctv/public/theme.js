// Dark or light, remembered per browser. Pure apart from the storage it is handed, so the rules are
// tested without a browser. Every storage call is guarded: a private window or blocked site data
// makes localStorage throw, and a theme preference is never worth breaking a page over.
export const THEME_KEY = 'cctv.theme'
const THEMES = ['dark', 'light']

/** The saved theme, or dark. Never throws. */
export function readTheme(storage) {
  try {
    const v = storage?.getItem(THEME_KEY)
    return THEMES.includes(v) ? v : 'dark'
  } catch {
    return 'dark'
  }
}

/** Saves a theme; false when it could not be stored or is not a theme. Never throws. */
export function saveTheme(storage, theme) {
  if (!THEMES.includes(theme)) return false
  try {
    storage.setItem(THEME_KEY, theme)
    return true
  } catch {
    return false
  }
}

export const nextTheme = (t) => (t === 'light' ? 'dark' : 'light')
