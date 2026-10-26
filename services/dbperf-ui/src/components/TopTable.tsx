import { Skeleton } from './activity/skeleton'
import { Fragment, useState } from 'react'
import type { Dimension, TableFilters, TopResponse } from '../api/types'
import { DIMENSIONS } from '../api/client'
import { waitCssColor as waitTypeColor } from '../lib/colors'
import { fmtNum, sliceLabel } from '../lib/format'
import { ColumnFilter } from './activity/column-filter'
export type Unit = 'AAS' | 'PERCENT'
interface Props {
  dimension: Dimension
  onDimension: (d: Dimension) => void
  data: TopResponse | null
  error: string | null
  loading: boolean
  unit: Unit
  onUnit: (u: Unit) => void
  onFilter: (dimension: Dimension, value: string) => void
  onQueryText: (hash: string) => void
  rawLevel: boolean
  filters: TableFilters
  onFilters: (f: TableFilters) => void
  offset: number
  onOffset: (v: number) => void
  pageSize: number
}
export function TopTable({
  dimension,
  onDimension,
  data,
  error,
  loading,
  unit,
  onUnit,
  onFilter,
  onQueryText,
  rawLevel,
  filters,
  onFilters,
  offset,
  onOffset,
  pageSize,
}: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const column =
    DIMENSIONS.find((d) => d.key === dimension)?.column ?? dimension
  const metric = unit === 'AAS' ? 'aas' : 'percent',
    other = unit === 'AAS' ? 'percent' : 'aas'
  const max = Math.max(0, ...(data?.entries ?? []).map((e) => e[metric]))
  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  const hasFilters =
    filters.dimensions.length > 0 || filters.aas || filters.percent
  return (
    <section
      className="card focus-table"
      aria-label="Таблица активности"
      aria-busy={loading}
    >
      <div className="focus-table-head">
        <h2>Активность по разрезам</h2>
        <div className="tabs" role="tablist" aria-label="Разрез таблицы">
          {DIMENSIONS.map((d) => (
            <button
              type="button"
              role="tab"
              aria-selected={d.key === dimension}
              key={d.key}
              disabled={!rawLevel && d.key === 'PID'}
              className={`tab ${d.key === dimension ? 'active' : ''}`}
              onClick={() => {
                setOpen(new Set())
                onDimension(d.key)
              }}
            >
              {d.label}
            </button>
          ))}
        </div>
        <div className="unit-toggle" role="group" aria-label="Единица таблицы">
          {(['AAS', 'PERCENT'] as Unit[]).map((u) => (
            <button
              type="button"
              key={u}
              className={`btn small ${unit === u ? 'active' : ''}`}
              aria-pressed={unit === u}
              onClick={() => onUnit(u)}
            >
              {u === 'AAS' ? 'AAS' : '%'}
            </button>
          ))}
        </div>
      </div>
      {hasFilters && (
        <div className="table-filter-bar">
          <span className="muted">Фильтры таблицы:</span>
          {filters.dimensions.map((f) => (
            <span className="chip" key={f.dimension}>
              <span>
                {DIMENSIONS.find((d) => d.key === f.dimension)?.label}:{' '}
                {f.exclude
                  ? 'не содержит'
                  : f.match === 'MATCH_TEXT_EQUALS'
                    ? '='
                    : 'содержит'}{' '}
                {f.values.join(', ')}
              </span>
              <button
                type="button"
                className="chip-x"
                aria-label={`Убрать фильтр ${f.dimension}`}
                onClick={() =>
                  onFilters({
                    ...filters,
                    dimensions: filters.dimensions.filter((x) => x !== f),
                  })
                }
              >
                ×
              </button>
            </span>
          ))}
          {(['aas', 'percent'] as const).map(
            (m) =>
              filters[m] && (
                <span className="chip" key={m}>
                  {m === 'aas' ? 'AAS' : '%'}: {filters[m]?.min ?? '0'} —{' '}
                  {filters[m]?.max ?? '∞'}
                  <button
                    type="button"
                    className="chip-x"
                    aria-label={`Убрать фильтр ${m}`}
                    onClick={() => onFilters({ ...filters, [m]: undefined })}
                  >
                    ×
                  </button>
                </span>
              ),
          )}
          <button
            type="button"
            className="link"
            onClick={() => onFilters({ dimensions: [] })}
          >
            Сбросить
          </button>
        </div>
      )}
      {error && !loading && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {loading && <span className="sr-only" role="status" aria-label="Загрузка таблицы">Загружаем активность…</span>}
      <div className="focus-table-scroll">
        <table className="top-table">
          <thead>
            <tr>
              <th className="col-exp" />
              <th className="col-activity">
                <div className="column-heading">
                  Активность, {unit === 'AAS' ? 'AAS' : '%'}
                  <ColumnFilter
                    key={metric}
                    column={metric}
                    title={unit === 'AAS' ? 'AAS' : 'Доля, %'}
                    value={filters}
                    onChange={onFilters}
                  />
                </div>
              </th>
              <th>
                <div className="column-heading">
                  {column}
                  <ColumnFilter
                    key={dimension}
                    column={dimension}
                    title={column}
                    value={filters}
                    onChange={onFilters}
                  />
                </div>
              </th>
              <th className="col-metric">
                <div className="column-heading">
                  {other === 'aas' ? 'AAS' : '%'}
                  <ColumnFilter
                    key={other}
                    column={other}
                    title={other === 'aas' ? 'AAS' : 'Доля, %'}
                    value={filters}
                    onChange={onFilters}
                  />
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? Array.from({ length: Math.max(1, Math.min(pageSize, data?.entries.length || pageSize)) }, (_, index) => (
              <tr className="table-skeleton-row" key={index} aria-hidden="true">
                <td />
                <td><Skeleton wide /></td>
                <td className="col-label"><Skeleton wide /></td>
                <td className="col-metric"><Skeleton /></td>
              </tr>
            )) : <>
            {(data?.entries ?? []).map((e) => {
              const key = `${dimension}:${e.slice.value}`,
                label = sliceLabel(dimension, e.slice)
              const segments = e.sub.length
                ? e.sub
                : [{ slice: e.slice, percent: 100 }]
              return (
                <Fragment key={key}>
                  <tr>
                    <td>
                      {e.sub.length > 0 && (
                        <button
                          type="button"
                          className="expander"
                          aria-label={`${open.has(key) ? 'Свернуть' : 'Развернуть'} ${label}`}
                          aria-expanded={open.has(key)}
                          onClick={() => toggle(key)}
                        >
                          {open.has(key) ? '⌄' : '›'}
                        </button>
                      )}
                    </td>
                    <td>
                      <div className="bar-cell">
                        <button
                          type="button"
                          className="bar"
                          aria-label={`Фильтр дашборда: ${label}`}
                          onClick={() =>
                            !e.slice.isRemainder &&
                            onFilter(dimension, e.slice.value)
                          }
                          style={{
                            width: `${max ? Math.max(2, (e[metric] / max) * 100) : 0}%`,
                          }}
                        >
                          {segments.map((s, i) => (
                            <span
                              key={i}
                              className="seg"
                              style={{
                                flex: s.percent || 1,
                                background: waitTypeColor(s.slice.value),
                              }}
                            />
                          ))}
                        </button>
                        <span className="value">{fmtNum(e[metric])}</span>
                      </div>
                    </td>
                    <td className="col-label" title={label}>
                      {dimension === 'QUERY' && !e.slice.isRemainder ? (
                        <button
                          type="button"
                          className="link query-link"
                          onClick={() => onQueryText(e.slice.value)}
                        >
                          {label}
                        </button>
                      ) : (
                        label
                      )}
                    </td>
                    <td className="col-metric">{fmtNum(e[other])}</td>
                  </tr>
                  {open.has(key) &&
                    e.sub.map((s, i) => (
                      <tr className="sub-row" key={i}>
                        <td />
                        <td>
                          <span
                            className="sw"
                            style={{ background: waitTypeColor(s.slice.value) }}
                          />{' '}
                          {fmtNum(unit === 'AAS' ? s.aas : s.percent)}
                          {unit === 'PERCENT' ? '% строки' : ''}
                        </td>
                        <td>{s.slice.value}</td>
                        <td>{fmtNum(unit === 'AAS' ? s.percent : s.aas)}</td>
                      </tr>
                    ))}
                </Fragment>
              )
            })}
            {!data?.entries.length && (
              <tr>
                <td colSpan={4} className="center muted">
                  {error
                      ? 'Данные недоступны'
                      : 'Нет значений за этот интервал с выбранными фильтрами'}
                </td>
              </tr>
            )}
            </>}
          </tbody>
        </table>
      </div>
      <div className="focus-table-footer">
        <span>
          {loading ? <Skeleton wide /> : <>Всего {fmtNum(data?.totalAas ?? 0)} AAS · снимков{' '}
          {data?.nSamples ?? 0} · {data?.level ?? '—'}</>}
        </span>
        <div className="row">
          <span>
            {loading ? <Skeleton /> : data?.matchedRows
              ? `${offset + 1}–${Math.min(offset + pageSize, data.matchedRows)} из ${data.matchedRows}`
              : '0 строк'}
          </span>
          <button
            type="button"
            className="btn small"
            disabled={!offset || loading}
            aria-label="Предыдущая страница"
            onClick={() => onOffset(Math.max(0, offset - pageSize))}
          >
            ‹
          </button>
          <button
            type="button"
            className="btn small"
            disabled={loading || offset + pageSize >= (data?.matchedRows ?? 0)}
            aria-label="Следующая страница"
            onClick={() => onOffset(offset + pageSize)}
          >
            ›
          </button>
        </div>
      </div>
    </section>
  )
}
