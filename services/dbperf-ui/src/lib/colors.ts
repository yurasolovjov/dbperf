import type { Dimension, SliceValue } from '../api/types'

// Wait types keep fixed colors so the same type looks the same on every chart
// and in the table bars (the Kintsugi legend: Client, LWLock, Lock, IO, CPU, other).
export const WAIT_TYPE_COLORS: Record<string, string> = {
  CPU: '#5cb85c',
  Lock: '#d9534f',
  LWLock: '#8b1a1a',
  IO: '#2a78d6',
  Client: '#8a8a8a',
  IPC: '#6250d6',
  Timeout: '#eda100',
  BufferPin: '#e87ba4',
  Activity: '#1baf7a',
  Extension: '#a0522d',
  other: '#c9c9c9',
}

// Categorical palette for every other dimension. The color is picked by a hash
// of the slice value, not by its rank in the response, so a query or a host
// keeps its color across refreshes and on both charts even when the top order
// changes. Twenty colors keep collisions among ten visible slices unlikely.
const CATEGORICAL = [
  '#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948', '#5d8aa8', '#a0522d',
  '#17becf', '#bcbd22', '#9467bd', '#ff7f0e', '#7f7f7f', '#8c564b', '#1f77b4', '#2ca02c', '#d62728', '#e377c2',
]

// fnv1a is the 32-bit FNV-1a hash of a string (over UTF-16 code units).
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export function hashColor(value: string): string {
  return CATEGORICAL[fnv1a(value) % CATEGORICAL.length]
}

export function sliceColor(dimension: Dimension, slice: SliceValue): string {
  if (slice.isRemainder) return WAIT_TYPE_COLORS.other
  if (dimension === 'WAIT_EVENT_TYPE') return WAIT_TYPE_COLORS[slice.value] ?? hashColor(slice.value)
  if (dimension === 'WAIT_EVENT') {
    const type = slice.value.split('.')[0]
    return WAIT_TYPE_COLORS[type] ?? hashColor(slice.value)
  }
  return hashColor(slice.value)
}

export function waitTypeColor(type: string): string {
  return WAIT_TYPE_COLORS[type] ?? WAIT_TYPE_COLORS.other
}

// CSS colors follow the theme without changing slice identity or refetching data.
export function hashCssColor(value: string): string {
  return `var(--category-${fnv1a(value) % CATEGORICAL.length})`
}
export function waitCssColor(type: string): string {
  return `var(--wait-${Object.prototype.hasOwnProperty.call(WAIT_TYPE_COLORS, type) ? type.toLowerCase() : 'other'})`
}
export function sliceCssColor(dimension: Dimension, slice: SliceValue): string {
  if (slice.isRemainder) return waitCssColor('other')
  if (dimension === 'WAIT_EVENT_TYPE') return Object.prototype.hasOwnProperty.call(WAIT_TYPE_COLORS, slice.value) ? waitCssColor(slice.value) : hashCssColor(slice.value)
  if (dimension === 'WAIT_EVENT') {
    const type = slice.value.split('.')[0]
    return Object.prototype.hasOwnProperty.call(WAIT_TYPE_COLORS, type) ? waitCssColor(type) : hashCssColor(slice.value)
  }
  return hashCssColor(slice.value)
}
