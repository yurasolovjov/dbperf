import type { Dimension, SliceValue } from '../api/types'

export function sliceLabel(dimension: Dimension, s: SliceValue): string {
  if (s.isRemainder) return 'other'
  if (dimension === 'QUERY') return s.shortText || `#${s.value}`
  return s.value
}

export function fmtTime(unix: number, withSeconds: boolean): string {
  const d = new Date(unix * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return withSeconds ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`
}

export function fmtNum(v: number, digits = 3): string {
  return v.toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

export function fmtDateTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString('ru-RU', { timeZone: 'Etc/GMT-3' })
}

export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} с`
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин`
  return `${Math.round(seconds / 3600)} ч`
}
