import { SelectChevron } from './activity/select-chevron'
import { useState } from 'react'
import type { Dimension } from '../api/types'
import { DIMENSIONS } from '../api/client'
import { DesignedSelect } from './activity/designed-select'
import { dateInput, validatePeriod } from './activity/range-model'
export const PERIODS = [
  { seconds: 60, label: '1 мин' },
  { seconds: 300, label: '5 мин' },
  { seconds: 900, label: '15 мин' },
  { seconds: 3600, label: '1 час' },
  { seconds: 86400, label: '24 часа' },
]
export const REFRESH = [
  { seconds: 0, label: 'Обновление выкл.' },
  { seconds: 5, label: 'Каждые 5 с' },
  { seconds: 10, label: 'Каждые 10 с' },
  { seconds: 30, label: 'Каждые 30 с' },
  { seconds: 60, label: 'Каждую минуту' },
]
export interface Period {
  seconds: number
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
  pidAvailable?: boolean
  onFullscreen?: () => void
  fullscreen?: boolean
}
export function Controls({
  period,
  onPeriod,
  dimension,
  onDimension,
  refresh,
  onRefresh,
  onReload,
  loading,
  pidAvailable = true,
  onFullscreen,
  fullscreen,
}: Props) {
  const [custom, setCustom] = useState(false)
  const [start, setStart] = useState(''),
    [end, setEnd] = useState(''),
    [error, setError] = useState('')
  const apply = () => {
    const result = validatePeriod(start, end)
    if (typeof result === 'string') {
      setError(result)
      return
    }
    onPeriod({ seconds: 0, start: result.startUnix, end: result.endUnix })
    setCustom(false)
  }
  return (
    <div className="focus-controls">
      <div className="period-control">
        <div
          className="btn-group period-group"
          role="group"
          aria-label="Период запроса"
        >
          {PERIODS.map((p) => (
            <button
              type="button"
              key={p.seconds}
              aria-pressed={period.seconds === p.seconds}
              className={`btn ${period.seconds === p.seconds ? 'active' : ''}`}
              onClick={() => {
                setCustom(false)
                onPeriod({ seconds: p.seconds })
              }}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            className={`btn ${!period.seconds ? 'active' : ''}`}
            aria-expanded={custom}
            onClick={() => {
              const now = Math.floor(Date.now() / 1000)
              setStart(dateInput(period.start ?? now - period.seconds))
              setEnd(dateInput(period.end ?? now))
              setError('')
              setCustom(!custom)
            }}
          >
            Произвольный <SelectChevron />
          </button>
        </div>
        {custom && (
          <form
            className="popover period-popover"
            aria-label="Произвольный период"
            onSubmit={(e) => {
              e.preventDefault()
              apply()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setCustom(false)
              }
            }}
          >
            <strong>Произвольный период</strong>
            <span className="muted">Дата и время · UTC+3</span>
            <label>
              Начало
              <input
                autoFocus
                type="datetime-local"
                step="1"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                required
              />
            </label>
            <label>
              Конец
              <input
                type="datetime-local"
                step="1"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                required
              />
            </label>
            {error && (
              <div role="alert" className="error">
                {error}
              </div>
            )}
            <div className="popover-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setCustom(false)}
              >
                Отмена
              </button>
              <button type="submit" className="btn primary">
                Применить период
              </button>
            </div>
          </form>
        )}
      </div>
      <DesignedSelect
        label="Разрез графиков"
        value={dimension}
        onChange={(v) => onDimension(v as Dimension)}
        options={DIMENSIONS.map((d) => ({
          value: d.key,
          label: d.label,
          disabled: d.key === 'PID' && !pidAvailable,
        }))}
      />
      <div className="focus-actions">
        <div className="refresh-control">
          <DesignedSelect
            label="Автообновление"
            value={String(refresh)}
            options={REFRESH.map((r) => ({
              value: String(r.seconds),
              label: r.label,
            }))}
            onChange={(v) => onRefresh(Number(v))}
          />
        </div>
        <button
          type="button"
          className="btn icon-btn"
          onClick={onReload}
          aria-label="Обновить данные"
        >
          <span className={loading ? 'spinning' : ''}>↻</span>
        </button>
        <button
          type="button"
          className="btn icon-btn"
          onClick={onFullscreen}
          aria-label={
            fullscreen
              ? 'Выйти из полного экрана'
              : 'Весь дашборд на полный экран'
          }
        >
          {fullscreen ? '⊡' : '⛶'}
        </button>
      </div>
    </div>
  )
}
