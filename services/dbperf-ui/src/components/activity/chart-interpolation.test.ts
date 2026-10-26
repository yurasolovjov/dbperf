import { test, expect } from 'vitest'
const assert = {
  ok: (value: unknown, message?: string) => expect(value, message).toBeTruthy(),
  equal: (a: unknown, b: unknown) => expect(a).toBe(b),
  deepEqual: (a: unknown, b: unknown) => expect(a).toEqual(b),
}
import type { TimeSeriesResponse } from '../../api/types'
import { chartDisplayData, monotoneSlopes, interpolateInterval, chartSegments } from './chart-interpolation'
const fixture = (timestamps: number[], values: number[][], stepSeconds = 10): TimeSeriesResponse => ({
  timestamps, stepSeconds, range: { startUnix: timestamps[0] ?? 0, endUnix: (timestamps[timestamps.length - 1] ?? 0) + stepSeconds }, level: 'raw',
  series: values.map((values, i) => ({ slice: { value: String(i), shortText: '', isRemainder: false, id: i }, values, average: 0 })),
  totals: timestamps.map((_, i) => values.reduce((sum, series) => sum + series[i], 0)),
})
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`)

test('passes through all measured snapshots without mutating API data', () => {
  const data = fixture([0, 10, 20, 30], [[0, 8, 1, 5], [5, 0, 2, 1]])
  const original = structuredClone(data), display = chartDisplayData(data, 'smooth')
  for (let i = 0; i < data.timestamps.length; i++) {
    const point = display.timestamps.indexOf(data.timestamps[i])
    assert.ok(point >= 0)
    display.values.forEach((values, j) => assert.equal(values[point], data.series[j].values[i]))
    assert.equal(display.totals[point], data.totals[i])
  }
  assert.deepEqual(data, original)
})
test('never overshoots a series or the total, even for opposing trends', () => {
  for (let seed = 1; seed <= 40; seed++) {
    let state = seed
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % 25 }
    const data = fixture([0, 3, 10, 12, 20, 30], Array.from({ length: 5 }, () => Array.from({ length: 6 }, random)), 10)
    const display = chartDisplayData(data, 'smooth')
    for (let i = 0; i < display.timestamps.length; i++) {
      if (display.totals[i] === null) continue
      const time = display.timestamps[i]
      const right = data.timestamps.findIndex(t => t >= time), left = Math.max(0, right - 1)
      const bounded = (value: number, a: number, b: number) => assert.ok(value >= Math.min(a, b) - 1e-8 && value <= Math.max(a, b) + 1e-8)
      display.values.forEach((values, j) => bounded(values[i]!, data.series[j].values[left], data.series[j].values[right]))
      bounded(display.totals[i]!, data.totals[left], data.totals[right])
      close(display.values.reduce((sum, values) => sum + values[i]!, 0), display.totals[i]!)
    }
  }
})
test('preserves collection gaps and the exact snapshot mode', () => {
  const data = fixture([0, 10, 40, 50], [[1, 2, 3, 4]])
  for (const mode of ['smooth', 'snapshots'] as const) {
    const display = chartDisplayData(data, mode)
    const nullIndex = display.totals.indexOf(null)
    assert.ok(nullIndex >= 0)
    assert.equal(display.values[0][nullIndex], null)
    assert.equal(display.timestamps[nullIndex + 1], 40)
    assert.ok(!display.timestamps.some((t, i) => t > 20 && t < 40 && display.totals[i] !== null))
  }
  const measured = chartDisplayData(data, 'snapshots')
  assert.deepEqual(measured.timestamps, [0, 10, 20, 20, 40, 50, 60])
  assert.deepEqual(measured.values[0], [1, 2, 2, null, 3, 4, 4])
})
test('handles empty, single, flat, two-point and total-only data', () => {
  assert.deepEqual(monotoneSlopes([], []), [])
  assert.deepEqual(monotoneSlopes([0], [7]), [0])
  assert.deepEqual(monotoneSlopes([0, 10], [2, 4]), [.2, .2])
  assert.deepEqual(monotoneSlopes([0, 10, 20], [4, 4, 4]), [0, 0, 0])
  assert.deepEqual(chartDisplayData(fixture([], []), 'smooth'), { timestamps: [], totals: [], values: [] })
  assert.deepEqual(chartDisplayData(fixture([0], [[7]]), 'smooth').totals, [7, 7])
  const totalOnly = { ...fixture([0, 10, 20], []), totals: [1, 9, 2] }
  assert.ok(chartDisplayData(totalOnly, 'smooth').totals.every(value => value! >= 1 && value! <= 9))
})
test('interpolation is continuous in value and tangent at measured points', () => {
  const x = [0, 3, 10, 20], y = [0, 5, 8, 1], m = monotoneSlopes(x, y), epsilon = 1e-6
  for (let i = 1; i < x.length - 1; i++) {
    const left = interpolateInterval(y[i - 1], y[i], m[i - 1], m[i], x[i] - x[i - 1], 1 - epsilon / (x[i] - x[i - 1]))
    const right = interpolateInterval(y[i], y[i + 1], m[i], m[i + 1], x[i + 1] - x[i], epsilon / (x[i + 1] - x[i]))
    assert.ok(Math.abs((y[i] - left) / epsilon - (right - y[i]) / epsilon) < 1e-4)
  }
})

test('separates the rendered groups at missing snapshots',()=>{
 const display=chartDisplayData(fixture([0,10,40,50],[[1,2,3,4]]),'smooth')
 const groups=chartSegments(display)
 assert.equal(groups.length,2)
 assert.ok(groups[0].every(i=>display.timestamps[i]<=10))
 assert.ok(groups[1].every(i=>display.timestamps[i]>=40))
 assert.deepEqual(chartSegments({timestamps:[],totals:[],values:[]}),[])
})
