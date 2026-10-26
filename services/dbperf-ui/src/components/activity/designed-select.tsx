import { SelectChevron } from './select-chevron'
import { createPortal } from 'react-dom'
import { popoverContainer, usePopoverPosition } from './use-popover-position'
import { useEffect, useId, useRef, useState } from 'react'
interface Option {
  value: string
  label: string
  disabled?: boolean
}
export function DesignedSelect({
  value,
  options,
  onChange,
  label,
}: {
  value: string
  options: Option[]
  onChange: (value: string) => void
  label: string
}) {
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const position = usePopoverPosition(open, trigger, menu)
  const id = useId()
  const search = useRef('')
  const searchedAt = useRef(0)
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (
        !ref.current?.contains(e.target as Node) &&
        !menu.current?.contains(e.target as Node)
      )
        setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    menu.current
      ?.querySelector<HTMLButtonElement>('[role=option][data-focused=true]')
      ?.focus()
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, index])
  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }
  const next = (delta: number) => {
    let n = index
    for (let i = 0; i < options.length; i++) {
      n = (n + delta + options.length) % options.length
      if (!options[n].disabled) break
    }
    setIndex(n)
  }
  return (
    <div
      className="designed-select"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          close()
        } else if (e.key === 'Tab') {
          setOpen(false)
          trigger.current?.focus()
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
          e.preventDefault()
          setOpen(true)
          if (e.key === 'Home') setIndex(options.findIndex((x) => !x.disabled))
          else if (e.key === 'End')
            setIndex(options.map((x) => !x.disabled).lastIndexOf(true))
          else next(e.key === 'ArrowDown' ? 1 : -1)
        } else if (open && e.key.length === 1 && e.key !== ' ') {
          const now = Date.now()
          search.current =
            (now - searchedAt.current < 700 ? search.current : '') +
            e.key.toLowerCase()
          searchedAt.current = now
          const found = options.findIndex(
            (x) =>
              !x.disabled && x.label.toLowerCase().startsWith(search.current),
          )
          if (found >= 0) setIndex(found)
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setIndex(
            Math.max(
              0,
              options.findIndex((x) => x.value === value),
            ),
          )
          setOpen(!open)
        }}
      >
        {options.find((x) => x.value === value)?.label ?? label}
        <SelectChevron />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            style={position}
            data-popover-owner={trigger.current
              ?.closest('[data-popover-scope]')
              ?.getAttribute('data-popover-scope')}
            id={id}
            role="listbox"
            aria-label={label}
            className="select-menu"
          >
            {options.map((o, i) => (
              <button
                type="button"
                role="option"
                key={o.value}
                aria-selected={o.value === value}
                disabled={o.disabled}
                data-focused={i === index}
                tabIndex={i === index ? 0 : -1}
                onClick={() => {
                  onChange(o.value)
                  close()
                }}
              >
                {o.label}
                <span aria-hidden>{o.value === value ? '✓' : ''}</span>
              </button>
            ))}
          </div>,
          popoverContainer(trigger.current),
        )}
    </div>
  )
}
