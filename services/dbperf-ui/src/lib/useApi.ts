import { useCallback, useEffect, useRef, useState } from 'react'

export interface ApiState<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

// useApi runs fn whenever deps change and every refreshSec seconds (0 = off).
// Stale responses are dropped through AbortController.
export function useApi<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[], refreshSec: number): ApiState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)
  const ctrl = useRef<AbortController | null>(null)
  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    ctrl.current?.abort()
    const c = new AbortController()
    ctrl.current = c
    setLoading(true)
    fn(c.signal)
      .then((d) => {
        if (c.signal.aborted) return
        setData(d)
        setError(null)
      })
      .catch((e: unknown) => {
        if (c.signal.aborted) return
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false)
      })
    return () => c.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  useEffect(() => {
    if (refreshSec <= 0) return
    const id = setInterval(reload, refreshSec * 1000)
    return () => clearInterval(id)
  }, [refreshSec, reload])

  return { data, error, loading, reload }
}
