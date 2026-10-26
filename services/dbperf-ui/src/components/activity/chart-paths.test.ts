import { expect, it } from 'vitest'
import { series } from '../../test/fixtures'
import { bucketAreaPath, smoothChartPaths } from './chart-paths'
const identity = (n: number) => n
it('fills between cumulative boundaries and clips the final bucket', () => {
  expect(bucketAreaPath([0, 10], [5, 7], [2, 3], 10, 15, identity, identity)).toBe('M0.0,5.0 L10.0,5.0 L10.0,7.0 L15.0,7.0 L15.0,3.0 L10.0,3.0 L10.0,2.0 L0.0,2.0 Z')
})
it('leaves missing snapshots empty instead of bridging them', () => {
  const path = bucketAreaPath([0, 30], [5, 7], [2, 3], 10, 40, identity, identity)
  expect(path.split('M')).toHaveLength(3)
  expect(path).toContain('L0.0,2.0 Z M30.0,7.0')
})
it('handles empty data and a single bucket', () => {
  expect(bucketAreaPath([], [], [], 10, 10, identity, identity)).toBe('')
  expect(bucketAreaPath([0], [4], [0], 10, 10, identity, identity)).toBe('M0.0,4.0 L10.0,4.0 L10.0,0.0 L0.0,0.0 Z')
})
it('does not emit NaN when a sparse series omits a bucket value',()=>{
 const path=bucketAreaPath([0,10],[],[],10,20,identity,identity)
 expect(path).not.toContain('NaN')
 expect(path).toContain('10.0,0.0')
})

it('smooth fills meet the total and remain separate across missing samples', () => {
  const paths = smoothChartPaths(series, series.range, 1000, 160)
  expect(paths.total.split('M')).toHaveLength(3)
  expect(paths.total).not.toMatch(/NaN| H/)
  expect(paths.bands[1].line).toBe(paths.total)
  for (const band of paths.bands) {
    expect(band.area.split('Z')).toHaveLength(3)
    expect(band.area.startsWith(band.line.split(' M')[0])).toBe(true)
  }
})
it('handles empty and total-only smooth SVGs', () => {
  expect(smoothChartPaths({...series, timestamps:[], totals:[], series:[]}, series.range, 1000, 160)).toEqual({bands:[],total:''})
  const paths = smoothChartPaths({...series, series:[]}, series.range, 1000, 160)
  expect(paths.bands).toEqual([])
  expect(paths.total).toContain('M')
})
