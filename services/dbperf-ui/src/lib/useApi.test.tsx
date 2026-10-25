import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useApi } from './useApi'
afterEach(() => vi.useRealTimers())
it('ignores a stale response even when a transport ignores abort', async () => {
  let finishOld: (v: string) => void = () => {}
  const old = new Promise<string>((resolve) => {
    finishOld = resolve
  })
  const { result, rerender } = renderHook(
    ({ id }) =>
      useApi(() => (id === 1 ? old : Promise.resolve('new')), [id], 0, true),
    { initialProps: { id: 1 } },
  )
  rerender({ id: 2 })
  await waitFor(() => expect(result.current.data).toBe('new'))
  await act(async () => finishOld('old'))
  expect(result.current.data).toBe('new')
})
it('clears old context data, reports errors and retries', async () => {
  const fn = vi
    .fn()
    .mockResolvedValueOnce('data')
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValueOnce('recovered')
  const { result, rerender } = renderHook(
    ({ id }) => useApi(fn, [id], 0, true),
    { initialProps: { id: 1 } },
  )
  await waitFor(() => expect(result.current.data).toBe('data'))
  rerender({ id: 2 })
  expect(result.current.data).toBeNull()
  await waitFor(() => expect(result.current.error).toBe('unavailable'))
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.data).toBe('recovered'))
  expect(result.current.error).toBeNull()
})
it('off disables periodic refresh and unmount aborts the request', async () => {
  const fn = vi.fn((signal: AbortSignal) => {
    expect(signal.aborted).toBe(false)
    return Promise.resolve('data')
  })
  const { result, unmount } = renderHook(() => useApi(fn, [], 0))
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(fn).toHaveBeenCalledTimes(1)
  const signal = fn.mock.calls[0][0]
  unmount()
  expect(signal.aborted).toBe(true)
})

it('retains profile data while refreshing the same context, but clears it for new filters', async () => {
  let finish: (v: string) => void = () => {}
  const pending = new Promise<string>((resolve) => {
    finish = resolve
  })
  const fn = vi
    .fn()
    .mockResolvedValueOnce('profile')
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce('filtered')
  const { result, rerender } = renderHook(
    ({ revision, filter }) => useApi(fn, [revision, filter], 0, true, [filter]),
    { initialProps: { revision: 0, filter: 'all' } },
  )
  await waitFor(() => expect(result.current.data).toBe('profile'))
  rerender({ revision: 1, filter: 'all' })
  expect(result.current.loading).toBe(true)
  expect(result.current.data).toBe('profile')
  await act(async () => finish('updated'))
  rerender({ revision: 1, filter: 'SQL' })
  expect(result.current.data).toBeNull()
  await waitFor(() => expect(result.current.data).toBe('filtered'))
})

it('refreshes periodically and cancels its timer on unmount', async () => {
  vi.useFakeTimers()
  const fn=vi.fn().mockResolvedValue('data')
  const {result,unmount}=renderHook(()=>useApi(fn,[],1))
  await act(async()=>{await Promise.resolve()})
  expect(result.current.data).toBe('data')
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000)})
  expect(fn).toHaveBeenCalledTimes(2)
  unmount()
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000)})
  expect(fn).toHaveBeenCalledTimes(2)
})
it('ignores cancelled failures, reports non-Error rejection and handles changed identity length',async()=>{
 let rejectOld!: (e:unknown)=>void
 const old=new Promise<string>((_,reject)=>{rejectOld=reject})
 const fn=vi.fn().mockReturnValueOnce(old).mockRejectedValueOnce('offline')
 const {result,rerender}=renderHook(({deps})=>useApi(fn,deps,0,true),{initialProps:{deps:[1]}})
 rerender({deps:[1,2]})
 await act(async()=>rejectOld(Error('stale')))
 await waitFor(()=>expect(result.current.error).toBe('offline'))
})
