import { expect, it } from 'vitest'
import { bucketAreaPath } from './chart-paths'
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
