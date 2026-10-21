import { useState } from 'react'
import type { Dimension, TopEntry, TopResponse } from '../api/types'
import { DIMENSIONS } from '../api/client'
import { waitTypeColor } from '../lib/colors'
import { fmtNum, sliceLabel } from '../lib/format'

export type Unit = 'AAS' | 'PERCENT'

interface Props {
  dimension: Dimension
  onDimension: (d: Dimension) => void
  data: TopResponse | null
  error: string | null
  unit: Unit
  onUnit: (u: Unit) => void
  onFilter: (dimension: Dimension, value: string) => void
  onQueryText: (hash: string) => void
  rawLevel: boolean
}

// TopTable is the "top activities" table: one row per slice value with a bar
// split by wait type (the nested slice), a value in AAS or percent, and the
// value of the dimension. Rows expand to the nested breakdown.
export function TopTable({ dimension, onDimension, data, error, unit, onUnit, onFilter, onQueryText, rawLevel }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const column = DIMENSIONS.find((d) => d.key === dimension)?.column ?? ''
  const max = Math.max(0, ...(data?.entries ?? []).map((e) => (unit === 'AAS' ? e.aas : e.percent)))

  const toggle = (v: string) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(v)) n.delete(v)
      else n.add(v)
      return n
    })

  return (
    <div className="card">
      <div className="tabs-row">
        <div className="tabs">
          {DIMENSIONS.filter((d) => rawLevel || d.key !== 'PID').map((d) => (
            <button key={d.key} className={`tab ${d.key === dimension ? 'active' : ''}`} onClick={() => onDimension(d.key)}>
              {d.label}
            </button>
          ))}
        </div>
        <div className="unit-toggle" role="group" aria-label="Единица измерения">
          <button className={`btn small ${unit === 'AAS' ? 'active' : ''}`} onClick={() => onUnit('AAS')} title="Среднее количество активных сессий">
            СКАС
          </button>
          <button className={`btn small ${unit === 'PERCENT' ? 'active' : ''}`} onClick={() => onUnit('PERCENT')} title="Доля от общей активности">
            %
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <table className="top-table">
        <thead>
          <tr>
            <th className="col-exp" />
            <th className="col-activity">
              Активность <span className="muted">{unit === 'AAS' ? 'СКАС' : '%'}</span>
            </th>
            <th>{column}</th>
          </tr>
        </thead>
        <tbody>
          {(data?.entries ?? []).map((e) => {
            const v = unit === 'AAS' ? e.aas : e.percent
            const key = e.slice.isRemainder ? '__other' : e.slice.value
            return (
              <Row
                key={key}
                entry={e}
                value={v}
                max={max}
                unit={unit}
                dimension={dimension}
                isOpen={open.has(key)}
                onToggle={() => toggle(key)}
                onFilter={() => !e.slice.isRemainder && onFilter(dimension, e.slice.value)}
                onQueryText={() => dimension === 'QUERY' && !e.slice.isRemainder && onQueryText(e.slice.value)}
              />
            )
          })}
          {data && data.entries.length === 0 && (
            <tr>
              <td colSpan={3} className="muted center">
                Нет активности в выбранном окне
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {data && (
        <div className="table-footer muted">
          Всего СКАС {fmtNum(data.totalAas)} · снимков {data.nSamples}
        </div>
      )}
    </div>
  )
}

interface RowProps {
  entry: TopEntry
  value: number
  max: number
  unit: Unit
  dimension: Dimension
  isOpen: boolean
  onToggle: () => void
  onFilter: () => void
  onQueryText: () => void
}

function Row({ entry, value, max, unit, dimension, isOpen, onToggle, onFilter, onQueryText }: RowProps) {
  const width = max > 0 ? (value / max) * 100 : 0
  const segments =
    entry.sub.length > 0 ? entry.sub : [{ slice: { value: 'other', isRemainder: true, shortText: '', id: 0 }, aas: entry.aas, percent: 100, sub: [] }]
  const label = sliceLabel(dimension, entry.slice)
  const isQuery = dimension === 'QUERY' && !entry.slice.isRemainder
  return (
    <>
      <tr className={entry.slice.isRemainder ? 'remainder' : ''}>
        <td className="col-exp">
          {entry.sub.length > 0 && (
            <button className="expander" onClick={onToggle} aria-label={isOpen ? 'Свернуть' : 'Развернуть'}>
              {isOpen ? '⌄' : '›'}
            </button>
          )}
        </td>
        <td className="col-activity">
          <div className="bar-cell">
            <div className="bar" style={{ width: `${width}%` }} title="Клик — добавить фильтр по этому значению" onClick={onFilter}>
              {segments.map((s, i) => (
                <span
                  key={i}
                  className="seg"
                  style={{ flex: s.percent, background: waitTypeColor(s.slice.isRemainder ? 'other' : s.slice.value) }}
                  title={`${s.slice.isRemainder ? 'other' : s.slice.value}: ${fmtNum(s.percent, 1)} %`}
                />
              ))}
            </div>
            <span className="value">{fmtNum(value)}</span>
          </div>
        </td>
        <td className={`col-label ${isQuery ? 'clickable' : ''}`} onClick={onQueryText} title={isQuery ? 'Показать текст запроса' : label}>
          {label}
        </td>
      </tr>
      {isOpen &&
        entry.sub.map((s, i) => (
          <tr key={i} className="sub-row">
            <td />
            <td className="col-activity">
              <div className="bar-cell">
                <span className="sw" style={{ background: waitTypeColor(s.slice.isRemainder ? 'other' : s.slice.value) }} />
                <span className="value">{unit === 'AAS' ? fmtNum(s.aas) : `${fmtNum(s.percent, 1)} % строки`}</span>
              </div>
            </td>
            <td className="col-label muted">{s.slice.isRemainder ? 'other' : s.slice.value}</td>
          </tr>
        ))}
    </>
  )
}
