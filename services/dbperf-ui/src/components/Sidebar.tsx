import { useMemo, useState } from 'react'
import { ThemeSwitch } from './ThemeSwitch'
import type { RegistryTarget } from '../api/registry'
import type { Route } from '../lib/router'

interface Props {
  targets: RegistryTarget[]
  owners: Map<number, string>
  route: Route
  onNavigate: (r: Route) => void
  error: string | null
}

// Sidebar lists every monitoring object; each one opens its own dashboard.
export function Sidebar({ targets, owners, route, onNavigate, error }: Props) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(true)
  const list = useMemo(() => {
    const f = q.trim().toLowerCase()
    return targets.filter((t) => !f || t.name.toLowerCase().includes(f) || Object.values(t.labels ?? {}).some((v) => v.toLowerCase().includes(f)))
  }, [targets, q])
  const current = route.page === 'activity' ? route.targetId : 0
  return (
    <aside className={`sidebar ${open ? '' : 'collapsed'}`}>
      <div className="sidebar-head">
        <span className="brand"><span className="brand-symbol" aria-hidden="true">▤</span>dbperf</span>
        <button className="btn icon-btn" onClick={() => setOpen((v) => !v)} title={open ? 'Скрыть панель' : 'Показать панель'} aria-label="Переключить панель">
          {open ? '‹' : '›'}
        </button>
      </div>
      <a className={`nav-link ${route.page === 'targets' ? 'active' : ''}`} href="#/targets" onClick={(e) => (e.preventDefault(), onNavigate({ page: 'targets' }))}>
        Объекты мониторинга <span className="muted">{targets.length}</span>
      </a>
      {open && (
        <>
          <input className="search" aria-label="Найти объект" placeholder="Найти объект…" value={q} onChange={(e) => setQ(e.target.value)} />
          {error && <div className="error small">{error}</div>}
          <ul className="target-list">
            {list.map((t) => {
              const owner = owners.get(t.targetId)
              return (
                <li key={t.targetId} className={t.targetId === current ? 'active' : ''}>
                  <a
                    href={`#/t/${t.targetId}/activity`}
                    onClick={(e) => (e.preventDefault(), onNavigate({ page: 'activity', targetId: t.targetId }))}
                    title={`${t.name}\n${owner ? 'ведёт ' + owner : t.enabled ? 'не назначен' : 'выключен'}`}
                  >
                    <span className={`dot ${!t.enabled ? 'off' : owner ? 'on' : 'idle'}`} />
                    <span className="name">{t.name}</span>
                    <span className="meta muted">{t.intervalSec} с</span>
                  </a>
                  <div className="sub muted">{owner ?? (t.enabled ? 'не назначен' : 'выключен')}</div>
                </li>
              )
            })}
            {list.length === 0 && <li className="muted empty">Нет объектов</li>}
          </ul>
        </>
      )}
      <footer className="sidebar-footer">
        <div className="sidebar-status"><span className="status-dot" />{targets.filter((t) => t.enabled).length} объектов включено</div>
        <ThemeSwitch />
      </footer>
    </aside>
  )
}
