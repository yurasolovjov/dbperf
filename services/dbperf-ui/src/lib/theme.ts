export type Theme = 'light' | 'dark'
export const THEME_KEY = 'dbperf-theme'

export function savedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function applyTheme(theme: Theme, persist = false) {
  document.documentElement.dataset.theme = theme
  if (persist) {
    try { localStorage.setItem(THEME_KEY, theme) } catch { /* Theme still works when storage is disabled. */ }
  }
}
