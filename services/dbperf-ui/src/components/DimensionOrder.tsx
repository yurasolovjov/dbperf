import type { Dimension } from '../api/types'
import { DIMENSIONS } from '../api/client'

interface Props {
  order: Dimension[]
  onChange: (order: Dimension[]) => void
  rawLevel: boolean
}

// DimensionOrder edits the frame order of the flame graph: root first.
export function DimensionOrder({ order, onChange, rawLevel }: Props) {
  const available = DIMENSIONS.filter((d) => !order.includes(d.key) && (rawLevel || d.key !== 'PID'))
  const move = (i: number, delta: number) => {
    const j = i + delta
    if (j < 0 || j >= order.length) return
    const next = [...order]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  return (
    <div className="dim-order">
      <span className="muted">Порядок:</span>
      {order.map((d, i) => (
        <span key={d} className="chip chip-dim">
          <button className="chip-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Левее">
            ‹
          </button>
          {DIMENSIONS.find((x) => x.key === d)?.label ?? d}
          <button className="chip-btn" onClick={() => move(i, 1)} disabled={i === order.length - 1} aria-label="Правее">
            ›
          </button>
          <button className="chip-x" onClick={() => order.length > 1 && onChange(order.filter((x) => x !== d))} aria-label="Убрать">
            ×
          </button>
        </span>
      ))}
      {available.length > 0 && (
        <select className="select small" value="" onChange={(e) => e.target.value && onChange([...order, e.target.value as Dimension])}>
          <option value="">+ добавить</option>
          {available.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
      )}
      <button className="btn small" onClick={() => onChange([...order].reverse())} title="Поменять корень и листья местами">
        ⇅ перевернуть
      </button>
    </div>
  )
}
