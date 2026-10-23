import { useCallback, useEffect, useState } from 'react'
import type { Dimension } from '../api/types'

// Hash routes:
//   #/targets                       — monitoring objects (CRUD, bulk import)
//   #/t/<id>/activity?dim=QUERY     — session activity dashboard of one instance
//   #target=2&dim=QUERY             — legacy form, still accepted
export type Route = { page: 'targets' } | { page: 'activity'; targetId: number; dim?: Dimension }

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, '')
  if (h.startsWith('/targets')) return { page: 'targets' }
  const m = h.match(/^\/t\/(\d+)\/activity(?:\?(.*))?$/)
  if (m) {
    const q = new URLSearchParams(m[2] ?? '')
    return { page: 'activity', targetId: Number(m[1]), dim: (q.get('dim') as Dimension) || undefined }
  }
  const legacy = new URLSearchParams(h)
  const t = Number(legacy.get('target'))
  return { page: 'activity', targetId: Number.isFinite(t) ? t : 0, dim: (legacy.get('dim') as Dimension) || undefined }
}

export function routeHash(r: Route): string {
  if (r.page === 'targets') return '#/targets'
  const q = r.dim ? `?dim=${r.dim}` : ''
  return `#/t/${r.targetId}/activity${q}`
}

export function useRoute(): [Route, (r: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const navigate = useCallback((r: Route, replace = false) => {
    const h = routeHash(r)
    if (window.location.hash === h) return
    if (replace) window.history.replaceState(null, '', h)
    else window.location.hash = h
    setRoute(r)
  }, [])
  return [route, navigate]
}
