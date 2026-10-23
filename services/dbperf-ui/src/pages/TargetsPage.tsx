import { useCallback, useState } from 'react'
import { ownerOf, redactDSN, registry, type RegistryTarget } from '../api/registry'
import { BulkImport } from '../components/BulkImport'
import { TargetForm } from '../components/TargetForm'
import { fmtDateTime } from '../lib/format'
import type { Route } from '../lib/router'
import { useApi } from '../lib/useApi'

interface Props {
  onNavigate: (r: Route) => void
  onChanged: () => void // the sidebar reloads its list
}

// TargetsPage: CRUD over monitoring objects and bulk import from YAML.
export function TargetsPage({ onNavigate, onChanged }: Props) {
  const [tick, setTick] = useState(0)
  const targets = useApi((s) => registry.list(s), [tick], 0)
  const assignments = useApi((s) => registry.assignments(s), [tick], 15)
  const [editing, setEditing] = useState<RegistryTarget | null | undefined>(undefined) // undefined = closed, null = create
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const changed = useCallback(() => {
    setTick((t) => t + 1)
    onChanged()
  }, [onChanged])

  const toggle = async (t: RegistryTarget) => {
    try {
      await registry.update({ ...t, enabled: !t.enabled }, ['enabled'])
      changed()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const remove = async (t: RegistryTarget) => {
    if (!window.confirm(`Удалить объект «${t.name}» (id ${t.targetId})? История в ClickHouse останется.`)) return
    try {
      await registry.delete(t.targetId)
      changed()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const owners = ownerOf(assignments.data)
  const f = filter.trim().toLowerCase()
  const list = (targets.data ?? []).filter((t) => !f || t.name.toLowerCase().includes(f) || Object.entries(t.labels ?? {}).some(([k, v]) => `${k}=${v}`.toLowerCase().includes(f)))

  return (
    <div className="page">
      <header className="topbar">
        <div className="crumbs"><span className="crumb-current">Объекты мониторинга</span></div>
        <div className="row">
          <input className="search" placeholder="Фильтр по имени или метке" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn" onClick={() => setImporting(true)}>⇪ Импорт YAML</button>
          <button className="btn primary" onClick={() => setEditing(null)}>+ Создать</button>
        </div>
      </header>
      {(error || targets.error) && <div className="error">{error ?? targets.error}</div>}
      <section className="card">
        <div className="table-x">
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th><th>Имя</th><th>Вкл</th><th>Интервал</th><th>Метки</th><th>Ведёт</th><th>DSN</th><th>Изменён</th><th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.targetId} className={t.enabled ? '' : 'row-muted'}>
                <td>{t.targetId}</td>
                <td className="mono"><a href={`#/t/${t.targetId}/activity`} onClick={(e) => (e.preventDefault(), onNavigate({ page: 'activity', targetId: t.targetId }))}>{t.name}</a></td>
                <td>
                  <label className="switch" title={t.enabled ? 'Выключить' : 'Включить'}>
                    <input type="checkbox" checked={t.enabled} onChange={() => toggle(t)} />
                    <span />
                  </label>
                </td>
                <td>{t.intervalSec} с</td>
                <td className="muted">{Object.entries(t.labels ?? {}).map(([k, v]) => <span key={k} className="chip chip-dim">{k}={v}</span>)}</td>
                <td>{owners.get(t.targetId) ?? <span className="muted">{t.enabled ? 'не назначен' : '—'}</span>}</td>
                <td className="mono muted dsn" title={redactDSN(t.dsn)}>{redactDSN(t.dsn)}</td>
                <td className="muted">{t.updatedAt ? fmtDateTime(t.updatedAt) : ''}</td>
                <td className="actions">
                  <button className="btn small" onClick={() => onNavigate({ page: 'activity', targetId: t.targetId })} title="Дашборд">Дашборд</button>
                  <button className="btn small" onClick={() => setEditing(t)} title="Изменить">Изменить</button>
                  <button className="btn small danger" onClick={() => remove(t)} title="Удалить">Удалить</button>
                </td>
              </tr>
            ))}
            {targets.data && list.length === 0 && (
              <tr><td colSpan={9} className="muted center">Объектов нет. Создайте первый или импортируйте YAML.</td></tr>
            )}
          </tbody>
        </table>
        </div>
        {assignments.data && (
          <div className="table-footer muted">
            Коллекторы: {assignments.data.instances?.map((i) => `${i.instance} (${i.targetIds?.length ?? 0} из ${i.capacity})`).join(', ') || 'нет живых'}
            {assignments.data.unassigned?.length ? ` · без владельца: ${assignments.data.unassigned.join(', ')}` : ''}
          </div>
        )}
      </section>
      {editing !== undefined && (
        <TargetForm target={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); changed() }} />
      )}
      {importing && <BulkImport onClose={() => setImporting(false)} onDone={changed} />}
    </div>
  )
}
