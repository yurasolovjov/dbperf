import { useCallback, useState } from 'react'
import { ownerOf, registry } from './api/registry'
import type { Dimension } from './api/types'
import { Sidebar } from './components/Sidebar'
import { useRoute } from './lib/router'
import { useApi } from './lib/useApi'
import { ActivityPage } from './pages/ActivityPage'
import { TargetsPage } from './pages/TargetsPage'

// App: sidebar with every monitoring object plus the routed page.
export default function App() {
  const [route, navigate] = useRoute()
  const [tick, setTick] = useState(0)
  const targets = useApi((s) => registry.list(s), [tick], 60)
  const assignments = useApi((s) => registry.assignments(s), [tick], 30)
  const reload = useCallback(() => setTick((t) => t + 1), [])
  const onDimensionChange = useCallback(
    (d: Dimension) => {
      if (route.page === 'activity' && route.dim !== d) navigate({ ...route, dim: d }, true)
    },
    [route, navigate],
  )
  return (
    <div className="layout">
      <Sidebar targets={targets.data ?? []} owners={ownerOf(assignments.data)} route={route} onNavigate={navigate} error={targets.error} />
      <main className="main">
        {route.page === 'targets' ? (
          <TargetsPage onNavigate={navigate} onChanged={reload} />
        ) : (
          <ActivityPage
            key={route.targetId}
            targetId={route.targetId}
            initialDimension={route.dim}
            onTargetChange={(id) => navigate({ page: 'activity', targetId: id, dim: route.page === 'activity' ? route.dim : undefined })}
            onDimensionChange={onDimensionChange}
          />
        )}
      </main>
    </div>
  )
}
