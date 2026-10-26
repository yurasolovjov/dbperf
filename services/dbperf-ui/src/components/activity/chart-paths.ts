import type { TimeRange, TimeSeriesResponse } from '../../api/types'
import { chartDisplayData, chartSegments } from './chart-interpolation'

// Each snapshot occupies one bucket. Missing buckets remain genuine gaps.
export function bucketAreaPath(
  timestamps: number[], top: number[], bottom: number[], step: number, end: number,
  x: (value: number) => number, y: (value: number) => number,
): string {
  const segments: number[][] = []
  timestamps.forEach((time, index) => {
    if (!index || time - timestamps[index - 1] > step * 1.5) segments.push([])
    segments[segments.length - 1].push(index)
  })
  const point = (time: number, value: number) => `${x(time).toFixed(1)},${y(value).toFixed(1)}`
  const right = (index: number) => Math.min(end, timestamps[index] + step, timestamps[index + 1] ?? end)
  return segments.map((indices) => {
    const upper = indices.flatMap((i) => [point(timestamps[i], top[i] ?? 0), point(right(i), top[i] ?? 0)])
    const lower = [...indices].reverse().flatMap((i) => [point(right(i), bottom[i] ?? 0), point(timestamps[i], bottom[i] ?? 0)])
    return `M${[...upper, ...lower].join(' L')} Z`
  }).join(' ')
}

// Every boundary uses the same interpolated grid. Closing against the next
// boundary keeps the stacked fills continuous, including the topmost band.
export function smoothChartPaths(data: TimeSeriesResponse, range: TimeRange, width: number, height: number) {
  const display = chartDisplayData(data, 'smooth')
  const segments = chartSegments(display)
  const max = Math.max(0.1, ...data.totals) * 1.08
  const x = (time: number) => 36 + (time - range.startUnix) / (range.endUnix - range.startUnix) * (width - 48)
  const y = (value: number) => 8 + (1 - value / max) * (height - 32)
  const point = (i: number, value: number) => `${x(display.timestamps[i]).toFixed(3)},${y(value).toFixed(3)}`
  const line = (values: (number | null)[]) => segments.map(indices =>
    `M${indices.map(i => point(i, values[i]!)).join(' L')}`).join(' ')
  const accumulated = display.timestamps.map(() => 0)
  const bands = display.values.map(values => {
    const bottom = [...accumulated]
    const top = values.map((value, i) => accumulated[i] += value ?? 0)
    const area = segments.map(indices => `M${[
      ...indices.map(i => point(i, top[i])),
      ...[...indices].reverse().map(i => point(i, bottom[i])),
    ].join(' L')} Z`).join(' ')
    return { area, line: line(top) }
  })
  return { bands, total: line(display.totals) }
}
