import type { Filter } from '../api/types'
import { DIMENSIONS } from '../api/client'

interface Props {
  filters: Filter[]
  onRemove: (i: number) => void
  onClear: () => void
  totalOnly: boolean
  onTotalOnly: (v: boolean) => void
  background: boolean
  onBackground: (v: boolean) => void
  expanded: boolean
  onExpand: () => void
}

export function FiltersBar({ filters, onRemove, onClear, totalOnly, onTotalOnly, background, onBackground, expanded, onExpand }: Props) {
  return (
    <div className="filters-bar">
      <div className="filters">
        <span className="info" title="Фильтр применяется к детальному графику и таблице. Клик по легенде или по полосе в таблице добавляет фильтр.">
          ⓘ
        </span>
        {filters.length === 0 ? (
          <span className="muted">Фильтры не выбраны</span>
        ) : (
          <>
            {filters.map((f, i) => (
              <span key={i} className="chip">
                {DIMENSIONS.find((d) => d.key === f.dimension)?.label ?? f.dimension}
                {f.exclude ? ' ≠ ' : ': '}
                {f.values.join(', ')}
                <button className="chip-x" onClick={() => onRemove(i)} aria-label="Убрать фильтр">
                  ×
                </button>
              </span>
            ))}
            <button className="link" onClick={onClear}>
              сбросить
            </button>
          </>
        )}
      </div>
      <div className="filters-right">
        <label className="checkbox" title="Показывать не только client backend, но и walsender, autovacuum и другие фоновые процессы">
          <input type="checkbox" checked={background} onChange={(e) => onBackground(e.target.checked)} />
          Фоновые процессы
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={totalOnly} onChange={(e) => onTotalOnly(e.target.checked)} />
          Общая активность
        </label>
        <button className="btn icon-btn" onClick={onExpand} title={expanded ? 'Свернуть график' : 'Развернуть график'} aria-label="Развернуть график">
          {expanded ? '⤡' : '⤢'}
        </button>
      </div>
    </div>
  )
}
