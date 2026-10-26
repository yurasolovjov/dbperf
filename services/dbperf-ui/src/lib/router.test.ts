import { expect, it } from 'vitest'
import { parseRoute, routeHash } from './router'
it('validates dimensions in modern and legacy routes', () => {
  expect(parseRoute('#/t/12/activity?dim=QUERY')).toEqual({
    page: 'activity',
    targetId: 12,
    dim: 'QUERY',
  })
  expect(parseRoute('#target=12&dim=QUERY')).toEqual({
    page: 'activity',
    targetId: 12,
    dim: 'QUERY',
  })
  expect(parseRoute('#/t/12/activity?dim=DROP_TABLE')).toEqual({
    page: 'activity',
    targetId: 12,
    dim: undefined,
  })
  expect(parseRoute('#/targets')).toEqual({ page: 'targets' })
  expect(routeHash({ page: 'activity', targetId: 12, dim: 'USENAME' })).toBe(
    '#/t/12/activity?dim=USENAME',
  )
})
