import { useState } from 'react'
import type { Dimension } from '../api/types'
import { DIMENSIONS } from '../api/client'

export const PERIODS = [
  { seconds: 60, label: '1 мин' },
  { seconds: 300, label: '5 мин' },
  { seconds: 900, label: '15 мин' },
  { seconds: 1800, label: '30 мин' },
  { seconds: 3600, label: '1 час' },
  { seconds: 6 * 3600, label: '6 часов' },
  { seconds: 24 * 3600, label: '1 день' },
]

export const REFRESH = [
  { seconds: 0, label: 'выкл' },
  { seconds: 5, label: '5 секунд' },
  { seconds: 10, label: '10 секунд' },
  { seconds: 30, label: '30 секунд' },
  { seconds: 60, label: '1 минута' },
]

export interface Period {
  seconds: number // preset length; 0 = custom
  start?: number
  end?: number
}

interface Props {
  period: Period
  onPeriod: (p: Period) => void
  dimension: Dimension
  onDimension: (d: Dimension) => void
  refresh: number
  onRefresh: (s: number) => void
  onReload: () => void
  loading: boolean
}

function toLocalInput(unix: number): string {
  const d = new Date(unix * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function Controls({ period, onPeriod, dimension, onDimension, refresh, onRefresh, onReload, loading }: Props) {
  const [custom, setCustom] = useState(false)
  const now = Math.floor(Date.now() / 1000)
  const [start, setStart] = useState(toLocalInput(period.start ?? now - 3600))
  const [end, setEnd] = useState(toLocalInput(period.end ?? now))

  const applyCustom = () => {
    const s = Math.floor(new Date(start).getTime() / 1000)
    const e = Math.floor(new Date(end).getTime() / 1000)
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return
    onPeriod({ seconds: 0, start: s, end: e })
    setCustom(false)
  }

  return (
    <div className="controls">
      <div className="control">
        <div className="control-label">Период</div>
        <div className="btn-group">
          {PERIODS.map((p) => (
            <button
              key={p.seconds}
              className={`btn ${period.seconds === p.seconds ? 'active' : ''}`}
              onClick={() => onPeriod({ seconds: p.seconds })}
            >
              {p.label}
            </button>
          ))}
          <button className={`btn ${period.seconds === 0 ? 'active' : ''}`} onClick={() => setCustom((v) => !v)}>
            <span className="icon">◷</span> Указать
          </button>
        </div>
        {custom && (
          <div className="popover">
            <label>
              Начало
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label>
              Конец
              <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
            <div className="popover-actions">
              <button className="btn" onClick={() => setCustom(false)}>
                Отмена
              </button>
              <button className="btn primary" onClick={applyCustom}>
                Применить
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="control">
        <div className="control-label">Разрез</div>
        <select className="select" value={dimension} onChange={(e) => onDimension(e.target.value as Dimension)}>
          {DIMENSIONS.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      <div className="control control-right">
        <div className="control-label">Автообновление</div>
        <div className="row">
          <select className="select" value={refresh} onChange={(e) => onRefresh(Number(e.target.value))}>
            {REFRESH.map((r) => (
              <option key={r.seconds} value={r.seconds}>
                {r.label}
              </option>
            ))}
          </select>
          <button className={`btn icon-btn ${loading ? 'spinning' : ''}`} onClick={onReload} title="Перезагрузка" aria-label="Перезагрузка">
            ↻
          </button>
        </div>
      </div>
    </div>
  )
}
