import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'

// Portaled overlays must stay inside the fullscreen root, outside scrolling tables.
export function popoverContainer(anchor: HTMLElement | null): Element {
  return (
    document.fullscreenElement ??
    anchor?.closest('.dashboard-fullscreen') ??
    document.body
  )
}
export function usePopoverPosition(
  open: boolean,
  anchor: RefObject<HTMLElement>,
  popup: RefObject<HTMLElement>,
  width?: number,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({
    position: 'fixed',
    visibility: 'hidden',
    minWidth: 0,
  })
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      if (!anchor.current || !popup.current) return
      const a = anchor.current.getBoundingClientRect(),
        p = popup.current.getBoundingClientRect()
      const w = Math.min(
        width ?? Math.max(a.width, 190),
        window.innerWidth - 24,
      )
      const h = Math.min(p.height, window.innerHeight - 24)
      const top =
        a.bottom + 5 + h <= window.innerHeight - 12
          ? a.bottom + 5
          : Math.max(12, a.top - h - 5)
      setStyle({
        position: 'fixed',
        visibility: 'visible',
        minWidth: 0,
        margin: 0,
        right: 'auto',
        left: Math.max(12, Math.min(a.left, window.innerWidth - w - 12)),
        top,
        width: w,
        maxWidth: window.innerWidth - 24,
        maxHeight: window.innerHeight - 24,
        overflowY: 'auto',
      })
    }
    update()
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    if (popup.current) observer?.observe(popup.current)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, anchor, popup, width])
  return style
}
