import { useEffect, useState } from 'react'
import { applyTheme, savedTheme, THEME_KEY, type Theme } from '../lib/theme'

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== THEME_KEY && event.key !== null) return
      const next = savedTheme()
      applyTheme(next)
      setTheme(next)
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
  function select(next: Theme) {
    applyTheme(next, true)
    setTheme(next)
  }
  return (
    <div className="theme-control">
      <span className="theme-label" id="theme-label">ТЕМА</span>
      <div className="theme-switch" role="group" aria-labelledby="theme-label">
        <button type="button" aria-pressed={theme === 'light'} onClick={() => select('light')} title="Светлая тема">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>
          <span>Светлая</span>
        </button>
        <button type="button" aria-pressed={theme === 'dark'} onClick={() => select('dark')} title="Тёмная тема">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M20.5 14a8.5 8.5 0 0 1-10.5-10.5A8.5 8.5 0 1 0 20.5 14Z"/></svg>
          <span>Тёмная</span>
        </button>
      </div>
    </div>
  )
}
