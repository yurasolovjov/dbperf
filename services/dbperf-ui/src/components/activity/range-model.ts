import type { TimeRange } from '../../api/types'
export type Selection = { start: number; end: number }
export const FULL: Selection = { start: 0, end: 1 }
export function clampSelection(s: Selection, min = 0.02): Selection {
  const width = Math.max(min, Math.min(1, s.end - s.start))
  const start = Math.max(0, Math.min(1 - width, s.start))
  return { start, end: start + width }
}
export function selectedRange(range: TimeRange, s: Selection): TimeRange {
  const span = range.endUnix - range.startUnix
  const startUnix = Math.floor(range.startUnix + span * s.start)
  return {
    startUnix,
    endUnix: Math.max(startUnix + 1, Math.ceil(range.startUnix + span * s.end)),
  }
}
export function moveSelection(
  s: Selection,
  mode: 'move' | 'start' | 'end',
  delta: number,
): Selection {
  if (mode === 'start')
    return {
      start: Math.max(0, Math.min(s.end - 0.02, s.start + delta)),
      end: s.end,
    }
  if (mode === 'end')
    return {
      start: s.start,
      end: Math.min(1, Math.max(s.start + 0.02, s.end + delta)),
    }
  return clampSelection({ start: s.start + delta, end: s.end + delta })
}
// Inputs use the explicitly displayed UTC+3, independently of the viewer's OS timezone.
export function dateInput(unix: number): string {
  return new Date((unix + 10800) * 1000).toISOString().slice(0, 19)
}
export function parseDateInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value))
    return null
  const ms = Date.parse(value + '+03:00')
  if (!Number.isFinite(ms)) return null
  if (
    dateInput(ms / 1000).slice(0, value.length > 16 ? 19 : 16) !==
    value.slice(0, 19)
  )
    return null
  return Math.floor(ms / 1000)
}
export function validatePeriod(start: string, end: string): TimeRange | string {
  const a = parseDateInput(start),
    b = parseDateInput(end)
  if (a === null || b === null) return 'Укажите корректные дату и время'
  if (b <= a) return 'Конец периода должен быть позже начала'
  if (b - a > 30 * 86400) return 'Максимальный период — 30 дней'
  return { startUnix: a, endUnix: b }
}
export function rangeLabel(r: TimeRange): string {
  const fmt = (t: number) =>
    new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Etc/GMT-3',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(t * 1000)
  return `${fmt(r.startUnix)} — ${fmt(r.endUnix)}`
}
