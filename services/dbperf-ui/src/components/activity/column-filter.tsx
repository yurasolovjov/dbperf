import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { popoverContainer, usePopoverPosition } from './use-popover-position'
import type { Dimension, TableFilters } from '../../api/types'
import { DesignedSelect } from './designed-select'
export type FilterColumn = Dimension | 'aas' | 'percent'
export function ColumnFilter({
  column,
  title,
  value,
  onChange,
}: {
  column: FilterColumn
  title: string
  value: TableFilters
  onChange: (f: TableFilters) => void
}) {
  const numeric = column === 'aas' || column === 'percent'
  const existing = value.dimensions.find((f) => f.dimension === column)
  const range = numeric ? value[column] : undefined
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(''),
    [op, setOp] = useState('contains'),
    [min, setMin] = useState(''),
    [max, setMax] = useState(''),
    [error, setError] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLFormElement>(null)
  const scope = useId()
  const position = usePopoverPosition(open, trigger, popup, 300)
  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }
  useEffect(() => {
    if (!open) return
    popup.current?.querySelector('input')?.focus()
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement
      if (
        target
          .closest('[data-popover-owner]')
          ?.getAttribute('data-popover-owner') === scope
      )
        return
      if (
        !popup.current?.contains(target) &&
        !trigger.current?.contains(target)
      )
        setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, scope])
  const apply = () => {
    if (numeric) {
      const a = min.trim() === '' ? undefined : Number(min),
        b = max.trim() === '' ? undefined : Number(max)
      if (
        [a, b].some(
          (v) =>
            v !== undefined &&
            (!Number.isFinite(v) || v < 0 || (column === 'percent' && v > 100)),
        ) ||
        (a !== undefined && b !== undefined && a > b)
      ) {
        setError('Проверьте границы диапазона')
        return
      }
      onChange({
        ...value,
        [column]:
          a === undefined && b === undefined ? undefined : { min: a, max: b },
      })
    } else {
      const dimensions = value.dimensions.filter((f) => f.dimension !== column)
      if (text.trim())
        dimensions.push({
          dimension: column,
          values: [text.trim()],
          match: op === 'equals' ? 'MATCH_TEXT_EQUALS' : 'MATCH_CONTAINS',
          exclude: op === 'excludes',
        })
      onChange({ ...value, dimensions })
    }
    close()
  }
  return (
    <div className="column-filter">
      <button
        ref={trigger}
        type="button"
        aria-label={`Фильтр: ${title}`}
        aria-expanded={open}
        className={`column-filter-button ${existing || range ? 'active' : ''}`}
        onClick={() => {
          setText(existing?.values[0] ?? '')
          setOp(
            existing?.exclude
              ? 'excludes'
              : existing?.match === 'MATCH_TEXT_EQUALS'
                ? 'equals'
                : 'contains',
          )
          setMin(String(range?.min ?? ''))
          setMax(String(range?.max ?? ''))
          setError('')
          setOpen(!open)
        }}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden
        >
          <path d="M3 4h18l-7 8v7l-4 2v-9z" />
        </svg>
      </button>
      {open &&
        createPortal(
          <form
            ref={popup}
            style={position}
            data-popover-scope={scope}
            className="popover column-popover"
            aria-label={`Фильтрация: ${title}`}
            onSubmit={(e) => {
              e.preventDefault()
              apply()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                close()
              }
            }}
          >
            <strong>{title}</strong>
            {numeric ? (
              <div className="numeric-fields">
                <label>
                  От
                  <input
                    autoFocus
                    type="number"
                    min="0"
                    max={column === 'percent' ? 100 : undefined}
                    step="any"
                    value={min}
                    onChange={(e) => setMin(e.target.value)}
                  />
                </label>
                <label>
                  До
                  <input
                    type="number"
                    min="0"
                    max={column === 'percent' ? 100 : undefined}
                    step="any"
                    value={max}
                    onChange={(e) => setMax(e.target.value)}
                  />
                </label>
              </div>
            ) : (
              <>
                <DesignedSelect
                  label="Условие"
                  value={op}
                  options={[
                    { value: 'contains', label: 'Содержит' },
                    { value: 'equals', label: 'Равно' },
                    { value: 'excludes', label: 'Не содержит' },
                  ]}
                  onChange={setOp}
                />
                <label>
                  Значение
                  <input
                    autoFocus
                    value={text}
                    maxLength={4096}
                    onChange={(e) => setText(e.target.value)}
                  />
                </label>
              </>
            )}
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <div className="popover-actions">
              <button type="button" className="btn" onClick={close}>
                Отмена
              </button>
              <button type="submit" className="btn primary">
                Применить фильтр
              </button>
            </div>
          </form>,
          popoverContainer(trigger.current),
        )}
    </div>
  )
}
