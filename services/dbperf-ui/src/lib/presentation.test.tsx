import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { fnv1a, hashColor, hashCssColor, sliceColor, sliceCssColor, waitTypeColor, waitCssColor, WAIT_TYPE_COLORS } from './colors'
import { fmtTime, fmtNum, fmtDateTime, fmtDuration, sliceLabel } from './format'
import { parseRoute, routeHash, useRoute } from './router'
import { slice } from '../test/fixtures'
it('keeps series colors stable, uses wait semantics and handles unknown values',()=>{
 expect(fnv1a('abc')).toBe(440920331)
 expect(hashColor('abc')).toBe(hashColor('abc'))
 expect(hashCssColor('abc')).toMatch(/^var\(--category-\d+\)$/)
 for(const dimension of ['WAIT_EVENT_TYPE','WAIT_EVENT','QUERY'] as const){
  expect(sliceColor(dimension,slice('CPU','',true))).toBe(WAIT_TYPE_COLORS.other)
  expect(sliceCssColor(dimension,slice('CPU','',true))).toBe('var(--wait-other)')
 }
 expect(sliceColor('WAIT_EVENT_TYPE',slice('CPU'))).toBe(WAIT_TYPE_COLORS.CPU)
 expect(sliceColor('WAIT_EVENT',slice('IO.Read'))).toBe(WAIT_TYPE_COLORS.IO)
 for(const dim of ['QUERY','WAIT_EVENT','WAIT_EVENT_TYPE'] as const){
  expect(sliceColor(dim,slice('unknown'))).toBe(hashColor('unknown'))
  expect(sliceCssColor(dim,slice('unknown'))).toBe(hashCssColor('unknown'))
 }
 expect(sliceCssColor('WAIT_EVENT',slice('IO.Read'))).toBe('var(--wait-io)')
 expect(sliceCssColor('WAIT_EVENT_TYPE',slice('CPU'))).toBe('var(--wait-cpu)')
 expect(waitTypeColor('CPU')).toBe(WAIT_TYPE_COLORS.CPU)
 expect(waitTypeColor('missing')).toBe(WAIT_TYPE_COLORS.other)
 expect(waitCssColor('__proto__')).toBe('var(--wait-other)')
})
it('formats user-facing time, duration and SQL labels',()=>{
 expect(sliceLabel('QUERY',slice('123','SELECT 1'))).toBe('SELECT 1')
 expect(sliceLabel('QUERY',slice('123'))).toBe('#123')
 expect(sliceLabel('QUERY',slice('other','',true))).toBe('other')
 expect(sliceLabel('DATNAME',slice('prod'))).toBe('prod')
 expect(fmtTime(0,true)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
 expect(fmtTime(0,false)).toHaveLength(5)
 expect(fmtNum(1.2345)).toBe('1,235');expect(fmtNum(1.2345,1)).toBe('1,2')
 expect(fmtDateTime(0)).toContain('03:00:00')
 expect([fmtDuration(3),fmtDuration(120),fmtDuration(7200)]).toEqual(['3 с','2 мин','2 ч'])
})
it('navigates, replaces hash state and reacts to browser history',async()=>{
 window.history.replaceState(null,'','#/targets')
 const {result,unmount}=renderHook(()=>useRoute())
 expect(result.current[0]).toEqual({page:'targets'})
 act(()=>result.current[1]({page:'activity',targetId:1}))
 expect(window.location.hash).toBe('#/t/1/activity')
 act(()=>result.current[1]({page:'activity',targetId:1}))
 act(()=>result.current[1]({page:'activity',targetId:2,dim:'QUERY'},true))
 expect(result.current[0]).toEqual({page:'activity',targetId:2,dim:'QUERY'})
 act(()=>{window.location.hash='#/targets';window.dispatchEvent(new HashChangeEvent('hashchange'))})
 await waitFor(()=>expect(result.current[0]).toEqual({page:'targets'}))
 unmount()
 expect(parseRoute('#target=NaN').page).toBe('activity')
 expect(routeHash({page:'targets'})).toBe('#/targets')
 expect(parseRoute('#/t/2/activity')).toMatchObject({targetId:2})
})
