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

// Categorical palette for every other dimension, assigned by rank in the response.
const CATEGORICAL = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948', '#5d8aa8', '#a0522d']

export function sliceColor(dimension: Dimension, slice: SliceValue): string {
  if (slice.isRemainder) return WAIT_TYPE_COLORS.other
  if (dimension === 'WAIT_EVENT_TYPE') return WAIT_TYPE_COLORS[slice.value] ?? CATEGORICAL[(slice.id - 1) % CATEGORICAL.length]
  if (dimension === 'WAIT_EVENT') {
    const type = slice.value.split('.')[0]
    return WAIT_TYPE_COLORS[type] ?? CATEGORICAL[(slice.id - 1) % CATEGORICAL.length]
  }
  return CATEGORICAL[(slice.id - 1) % CATEGORICAL.length]
}

export function waitTypeColor(type: string): string {
  return WAIT_TYPE_COLORS[type] ?? WAIT_TYPE_COLORS.other
}
