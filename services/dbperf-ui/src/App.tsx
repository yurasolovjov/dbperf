import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api/client'
import type { Dimension, Filter, TimeRange } from './api/types'
import { ActivityChart } from './components/ActivityChart'
import { Controls, type Period } from './components/Controls'
import { FiltersBar } from './components/FiltersBar'
import { QueryModal } from './components/QueryModal'
import { TopBar } from './components/TopBar'
import { TopTable, type Unit } from './components/TopTable'
import { useApi } from './lib/useApi'

const RAW_RANGE_LIMIT = 2 * 3600 // seconds; longer ranges are served from the 1m level
const OVERVIEW_POINTS = 120
const DEFAULT_WINDOW = 300

// The scraper stores every active backend, walsender and autovacuum workers
// included; the dashboard shows client backends unless background processes
// are switched on in the filters bar.
const CLIENT_BACKEND_FILTER: Filter = { dimension: 'BACKEND_TYPE', values: ['client backend'] }

function periodRange(p: Period, now: number): TimeRange {
  if (p.seconds === 0 && p.start && p.end) return { startUnix: p.start, endUnix: p.end }
  return { startUnix: now - p.seconds, endUnix: now }
}

// The sliding window stays attached to the end of the period while the user
// has not moved it, so auto refresh keeps showing the latest data.
function defaultWindow(r: TimeRange): TimeRange {
  const len = Math.min(DEFAULT_WINDOW, r.endUnix - r.startUnix)
  return { startUnix: r.endUnix - len, endUnix: r.endUnix }
}

function readHash(): { targetId?: number; dimension?: Dimension } {
  const h = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const t = Number(h.get('target'))
  const d = h.get('dim') as Dimension | null
  return { targetId: Number.isFinite(t) && t > 0 ? t : undefined, dimension: d ?? undefined }
}

export default function App() {
  const initial = useMemo(readHash, [])
  const [targetId, setTargetId] = useState<number>(initial.targetId ?? 0)
  const [period, setPeriod] = useState<Period>({ seconds: 900 })
  const [dimension, setDimension] = useState<Dimension>(initial.dimension ?? 'WAIT_EVENT_TYPE')
  const [tableDim, setTableDim] = useState<Dimension>(initial.dimension ?? 'WAIT_EVENT_TYPE')
  const [refresh, setRefresh] = useState(10)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const [windowSel, setWindowSel] = useState<TimeRange | null>(null) // null = attached to the end
  const [filters, setFilters] = useState<Filter[]>([])
  const [totalOnly, setTotalOnly] = useState(false)
  const [background, setBackground] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [unit, setUnit] = useState<Unit>('PERCENT')
  const [queryHash, setQueryHash] = useState<string | null>(null)

  const range = useMemo(() => periodRange(period, now), [period, now])
  const win = windowSel ?? defaultWindow(range)
  const rawLevel = range.endUnix - range.startUnix <= RAW_RANGE_LIMIT
  const baseFilters = useMemo<Filter[]>(() => (background ? [] : [CLIENT_BACKEND_FILTER]), [background])
  const queryFilters = useMemo<Filter[]>(() => [...baseFilters, ...filters], [baseFilters, filters])
  const overviewStep = Math.max(10, Math.floor((range.endUnix - range.startUnix) / OVERVIEW_POINTS))

  // Targets and status
  const targets = useApi((s) => api.listTargets(s), [], 60)
  useEffect(() => {
    if (targetId === 0 && targets.data && targets.data.length > 0) setTargetId(targets.data[0].targetId)
  }, [targets.data, targetId])
  const status = useApi((s) => (targetId ? api.targetStatus(targetId, s) : Promise.resolve(null)), [targetId], refresh || 30)

  useEffect(() => {
    const h = new URLSearchParams()
    if (targetId) h.set('target', String(targetId))
    h.set('dim', dimension)
    if (window.location.hash !== `#${h.toString()}`) window.history.replaceState(null, '', `#${h.toString()}`)
  }, [targetId, dimension])

  // A hash typed into the address bar (or a link) switches target and dimension.
  useEffect(() => {
    const onHash = () => {
      const h = readHash()
      if (h.targetId) setTargetId(h.targetId)
      if (h.dimension) {
        setDimension(h.dimension)
        setTableDim(h.dimension)
      }
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Auto refresh moves "now"; a preset period slides with it.
  useEffect(() => {
    if (refresh <= 0) return
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), refresh * 1000)
    return () => clearInterval(id)
  }, [refresh])
  const reload = useCallback(() => setNow(Math.floor(Date.now() / 1000)), [])

  const overview = useApi(
    (s) =>
      targetId
        ? api.timeSeries({ targetId, range, stepSeconds: overviewStep, slicing: { dimension, limit: 10 }, filters: baseFilters, excludeSelf: true, maxPoints: OVERVIEW_POINTS + 2 }, s)
        : Promise.resolve(null),
    [targetId, range.startUnix, range.endUnix, overviewStep, dimension, baseFilters],
    0,
  )
  const detail = useApi(
    (s) =>
      targetId
        ? api.timeSeries({ targetId, range: win, stepSeconds: 10, slicing: { dimension, limit: 10 }, filters: queryFilters, excludeSelf: true, maxPoints: 720 }, s)
        : Promise.resolve(null),
    [targetId, win.startUnix, win.endUnix, dimension, queryFilters],
    0,
  )
  const top = useApi(
    (s) =>
      targetId
        ? api.top({ targetId, range: win, slicing: { dimension: tableDim, limit: 25 }, subSlicing: { dimension: 'WAIT_EVENT_TYPE', limit: 10 }, filters: queryFilters, excludeSelf: true }, s)
        : Promise.resolve(null),
    [targetId, win.startUnix, win.endUnix, tableDim, queryFilters],
    0,
  )

  const addFilter = useCallback((dim: Dimension, value: string) => {
    setFilters((fs) => {
      const i = fs.findIndex((f) => f.dimension === dim && !f.exclude)
      if (i >= 0) {
        if (fs[i].values.includes(value)) return fs
        const next = [...fs]
        next[i] = { ...fs[i], values: [...fs[i].values, value] }
        return next
      }
      return [...fs, { dimension: dim, values: [value] }]
    })
  }, [])

  const onPeriod = (p: Period) => {
    setPeriod(p)
    setWindowSel(null)
    setNow(Math.floor(Date.now() / 1000))
  }
  const onDimension = (d: Dimension) => {
    setDimension(d)
    setTableDim(d)
  }

  const loading = overview.loading || detail.loading || top.loading
  const error = targets.error || overview.error || detail.error

  return (
    <div className="page">
      <TopBar targets={targets.data ?? []} targetId={targetId} status={status.data} onChange={(id) => setTargetId(id)} />
      <Controls period={period} onPeriod={onPeriod} dimension={dimension} onDimension={onDimension} refresh={refresh} onRefresh={setRefresh} onReload={reload} loading={loading} />
      {error && <div className="error">{error}</div>}

      <section className="card">
        <ActivityChart data={overview.data} dimension={dimension} height={190} window={win} onWindow={(w) => setWindowSel(w)} tickSeconds={false} emptyText="Нет данных за период" />
        <div className="hint muted">Выделите область на графике, чтобы задать окно для детального графика и таблицы</div>
      </section>

      <section className="card">
        <FiltersBar
          filters={filters}
          onRemove={(i) => setFilters((fs) => fs.filter((_, j) => j !== i))}
          onClear={() => setFilters([])}
          totalOnly={totalOnly}
          onTotalOnly={setTotalOnly}
          background={background}
          onBackground={setBackground}
          expanded={expanded}
          onExpand={() => setExpanded((v) => !v)}
        />
        <ActivityChart
          data={detail.data}
          dimension={dimension}
          height={expanded ? 420 : 220}
          totalOnly={totalOnly}
          onLegendClick={(v) => addFilter(dimension, v)}
          tickSeconds={win.endUnix - win.startUnix <= 1800}
          emptyText="Нет активных сессий в окне"
        />
      </section>

      <TopTable
        dimension={tableDim}
        onDimension={setTableDim}
        data={top.data}
        error={top.error}
        unit={unit}
        onUnit={setUnit}
        onFilter={addFilter}
        onQueryText={setQueryHash}
        rawLevel={rawLevel}
      />
      <QueryModal targetId={targetId} hash={queryHash} onClose={() => setQueryHash(null)} />
    </div>
  )
}
