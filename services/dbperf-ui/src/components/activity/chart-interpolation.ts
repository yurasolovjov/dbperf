import type { TimeSeriesResponse } from '../../api/types'

export type ChartMode = 'smooth' | 'snapshots'
export interface ChartDisplayData {
  timestamps: number[]
  totals: (number | null)[]
  values: (number | null)[][]
}

// Shape-preserving cubic Hermite interpolation (PCHIP). The harmonic slopes
// become zero at extrema; endpoint slopes are limited to prevent overshoot.
export function monotoneSlopes(x: number[], y: number[]): number[] {
  const n = x.length
  if (n < 2) return x.map(() => 0)
  const h = x.slice(1).map((value, i) => value - x[i])
  const d = h.map((width, i) => (y[i + 1] - y[i]) / width)
  if (n === 2) return [d[0], d[0]]
  const slopes = x.map(() => 0)
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) continue
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]
    slopes[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
  }
  const endpoint = (a: number, b: number, da: number, db: number) => {
    const slope = ((2 * a + b) * da - a * db) / (a + b)
    if (slope * da <= 0) return 0
    return da * db <= 0 && Math.abs(slope) > Math.abs(3 * da) ? 3 * da : slope
  }
  slopes[0] = endpoint(h[0], h[1], d[0], d[1])
  slopes[n - 1] = endpoint(h[n - 2], h[n - 3], d[n - 2], d[n - 3])
  return slopes
}

export function interpolateInterval(a: number, b: number, slopeA: number, slopeB: number, width: number, t: number): number {
  const t2 = t * t, t3 = t2 * t
  const value = (2 * t3 - 3 * t2 + 1) * a + (t3 - 2 * t2 + t) * width * slopeA
    + (-2 * t3 + 3 * t2) * b + (t3 - t2) * width * slopeB
  // Bound roundoff as well as the range; never invent a negative active count.
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), value))
}

export function chartDisplayData(data: TimeSeriesResponse, mode: ChartMode): ChartDisplayData {
  const output: ChartDisplayData = { timestamps: [], totals: [], values: data.series.map(() => []) }
  const subdivisions = Math.max(4, Math.min(12, Math.floor(9000 / Math.max(1, data.timestamps.length))))
  const append = (time: number, values: (number | null)[], total: number | null) => {
    output.timestamps.push(time)
    output.totals.push(total)
    values.forEach((value, i) => output.values[i].push(value))
  }
  let start = 0
  while (start < data.timestamps.length) {
    let end = start + 1
    while (end < data.timestamps.length && data.timestamps[end] > data.timestamps[end - 1]
      && data.timestamps[end] - data.timestamps[end - 1] <= data.stepSeconds * 1.5) end++
    const times = data.timestamps.slice(start, end)
    const values = data.series.map(series => series.values.slice(start, end))
    const slopes = mode === 'smooth' ? values.map(series => monotoneSlopes(times, series)) : []
    const totalSlopes = mode === 'smooth' ? monotoneSlopes(times, data.totals.slice(start, end)) : []
    // A common reduction of the series derivatives also bounds the sum's
    // derivative. Thus neither individual series nor the total gains extrema,
    // while the sum of all areas still matches the total curve at every point.
    if (mode === 'smooth' && slopes.length) {
      times.forEach((_, i) => {
        const sum = slopes.reduce((value, series) => value + series[i], 0)
        const factor = sum === 0 ? 1 : sum * totalSlopes[i] <= 0 ? 0 : Math.min(1, Math.abs(totalSlopes[i] / sum))
        slopes.forEach(series => { series[i] *= factor })
      })
    }
    for (let i = 0; i < times.length; i++) {
      append(times[i], values.map(series => series[i]), data.totals[start + i])
      if (mode !== 'smooth' || i === times.length - 1) continue
      const width = times[i + 1] - times[i]
      for (let k = 1; k < subdivisions; k++) {
        const t = k / subdivisions
        const point = values.map((series, j) => interpolateInterval(series[i], series[i + 1], slopes[j][i], slopes[j][i + 1], width, t))
        // Stacked areas and the total share the same grid. Summing nonnegative
        // interpolated series keeps all cumulative boundaries ordered.
        const total = point.length ? point.reduce((sum, value) => sum + value, 0)
          : interpolateInterval(data.totals[start + i], data.totals[start + i + 1], totalSlopes[i], totalSlopes[i + 1], width, t)
        append(times[i] + width * t, point, total)
      }
    }
    const last = times.length - 1
    const edge = Math.min(data.range.endUnix, times[last] + data.stepSeconds)
    if ((mode === 'snapshots' || times.length === 1) && edge > times[last]) {
      append(edge, values.map(series => series[last]), data.totals[end - 1])
    }
    if (end < data.timestamps.length) {
      // Independent segments leave the missing span unpainted.
      append(mode === 'snapshots' ? edge : times[last], values.map(() => null), null)
    }
    start = end
  }
  return output
}

// Keep missing collection intervals as independent SVG paths.
export function chartSegments(data: ChartDisplayData): number[][] {
  const segments: number[][] = []
  data.totals.forEach((total, i) => {
    if (total === null) return
    if (i === 0 || data.totals[i - 1] === null) segments.push([])
    segments[segments.length - 1].push(i)
  })
  return segments
}
