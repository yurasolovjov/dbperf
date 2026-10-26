import { Skeleton } from '../components/activity/skeleton'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, DIMENSIONS } from '../api/client'
import { registry } from '../api/registry'
import type { Dimension, Filter, TableFilters } from '../api/types'
import { Controls, type Period } from '../components/Controls'
import { DimensionOrder } from '../components/DimensionOrder'
import { QueryModal } from '../components/QueryModal'
import { TopBar } from '../components/TopBar'
import { TopTable, type Unit } from '../components/TopTable'
import type { ChartMode } from '../components/activity/chart-interpolation'
import { BrushChart } from '../components/activity/brush-chart'
import { ProfileView } from '../components/activity/profile-view'
import {
  FULL,
  rangeLabel,
  selectedRange,
  type Selection,
} from '../components/activity/range-model'
import { sliceCssColor as sliceColor } from '../lib/colors'
import { sliceLabel } from '../lib/format'
import { useApi } from '../lib/useApi'
const CLIENT: Filter = { dimension: 'BACKEND_TYPE', values: ['client backend'] }
interface Props {
  targetId: number
  initialDimension?: Dimension
  onTargetChange: (id: number) => void
  onDimensionChange: (d: Dimension) => void
}
export function ActivityPage({
  targetId,
  initialDimension,
  onTargetChange,
  onDimensionChange,
}: Props) {
  const root = useRef<HTMLDivElement>(null)
  const [period, setPeriod] = useState<Period>({ seconds: 900 })
  const dimension = initialDimension ?? 'WAIT_EVENT_TYPE'
  const [tableDim, setTableDim] = useState<Dimension>(dimension)
  const [refresh, setRefresh] = useState(10),
    [now, setNow] = useState(() => Math.floor(Date.now() / 1000)),
    [revision, setRevision] = useState(0)
  const [focus, setFocus] = useState<Selection>({ start: 0.65, end: 1 }),
    [analysis, setAnalysis] = useState<Selection>(FULL)
  const [globalFilters, setGlobalFilters] = useState<Filter[]>([]),
    [legend, setLegend] = useState<string | null>(null)
  const [tableFilters, setTableFilters] = useState<TableFilters>({
      dimensions: [],
    }),
    [offset, setOffset] = useState(0)
  const [background, setBackground] = useState(false),
    [totalOnly, setTotalOnly] = useState(false),
    [fullscreen, setFullscreen] = useState(false)
  const [unit, setUnit] = useState<Unit>('PERCENT'),
    [queryHash, setQueryHash] = useState<string | null>(null)
  const [chartMode, setChartMode] = useState<ChartMode>('smooth')
  const [view, setView] = useState<'chart' | 'profile'>('chart')
  const [profileOrder, setProfileOrder] = useState<Dimension[]>([
    'QUERY',
    'DATNAME',
    'WAIT_EVENT_TYPE',
    'WAIT_EVENT',
  ])
  const range = useMemo(
    () => ({
      startUnix: period.seconds ? now - period.seconds : period.start!,
      endUnix: period.seconds ? now : period.end!,
    }),
    [period, now],
  )
  const win = useMemo(() => selectedRange(range, focus), [range, focus])
  const analyzed = useMemo(() => selectedRange(win, analysis), [win, analysis])
  const filters = useMemo(
    () => [
      ...(background ? [] : [CLIENT]),
      ...globalFilters,
      ...(legend === null ? [] : [{ dimension, values: [legend] }]),
    ],
    [background, globalFilters, legend, dimension],
  )
  const targets = useApi((s) => registry.list(s), [], 60)
  useEffect(() => {
    if (!targetId && targets.data?.length)
      onTargetChange(targets.data[0].targetId)
  }, [targetId, targets.data, onTargetChange])
  const status = useApi(
    (s) => (targetId ? api.targetStatus(targetId, s) : Promise.resolve(null)),
    [targetId, revision],
    refresh,
  )
  const reload = useCallback(() => {
    setNow(Math.floor(Date.now() / 1000))
    setRevision((v) => v + 1)
  }, [])
  useEffect(() => {
    if (!refresh) return
    const id = setInterval(reload, refresh * 1000)
    return () => clearInterval(id)
  }, [refresh, reload])
  const overview = useApi(
    (s) =>
      targetId
        ? api.timeSeries(
            {
              targetId,
              range,
              stepSeconds: Math.max(
                1,
                Math.ceil((range.endUnix - range.startUnix) / 120),
              ),
              slicing: { dimension, limit: 10 },
              filters,
              excludeSelf: true,
              maxPoints: 122,
            },
            s,
          )
        : Promise.resolve(null),
    [targetId, range.startUnix, range.endUnix, dimension, filters, revision],
    0,
    true,
    [targetId, period, dimension, filters],
  )
  const detail = useApi(
    (s) =>
      targetId
        ? api.timeSeries(
            {
              targetId,
              range: win,
              stepSeconds: 0,
              slicing: { dimension, limit: 10 },
              filters,
              excludeSelf: true,
              maxPoints: 720,
            },
            s,
          )
        : Promise.resolve(null),
    [targetId, win.startUnix, win.endUnix, dimension, filters, revision],
    0,
    true,
    [targetId, period, focus, dimension, filters],
  )
  const totals = useApi(
    (s) =>
      targetId
        ? api.totals(
            {
              targetId,
              range: analyzed,
              stepSeconds: 0,
              filters,
              excludeSelf: true,
            },
            s,
          )
        : Promise.resolve(null),
    [targetId, analyzed.startUnix, analyzed.endUnix, filters, revision],
    0,
    true,
    [targetId, period, focus, analysis, filters],
  )
  const profile = useApi(
    (s) =>
      targetId && view === 'profile'
        ? api.profile(
            {
              targetId,
              range: win,
              dimensions: profileOrder,
              filters,
              excludeSelf: true,
              minSamples: 1,
              maxPaths: 20000,
            },
            s,
          )
        : Promise.resolve(null),
    [
      targetId,
      win.startUnix,
      win.endUnix,
      profileOrder,
      filters,
      view,
      revision,
    ],
    0,
    true,
    [targetId, period, focus, profileOrder, filters, view],
  )
  const top = useApi(
    (s) =>
      targetId
        ? api.top(
            {
              targetId,
              range: analyzed,
              slicing: { dimension: tableDim, limit: 8 },
              subSlicing: { dimension: 'WAIT_EVENT_TYPE', limit: 10 },
              filters,
              tableFilters: tableFilters.dimensions,
              aas: tableFilters.aas,
              percent: tableFilters.percent,
              pageSize: 8,
              offset,
              excludeSelf: true,
            },
            s,
          )
        : Promise.resolve(null),
    [
      targetId,
      analyzed.startUnix,
      analyzed.endUnix,
      tableDim,
      filters,
      tableFilters,
      offset,
      revision,
    ],
    0,
    true,
    [
      targetId,
      period,
      focus,
      analysis,
      tableDim,
      filters,
      tableFilters,
      offset,
    ],
  )
  const [legendItems, setLegendItems] = useState<
    { value: string; label: string; color: string; remainder: boolean }[]
  >([])
  useEffect(() => {
    if (!legend && detail.data)
      setLegendItems(
        detail.data.series.map((s) => ({
          value: s.slice.value,
          label: sliceLabel(dimension, s.slice),
          color: sliceColor(dimension, s.slice),
          remainder: s.slice.isRemainder,
        })),
      )
  }, [detail.data, dimension, legend])
  const previousDimension = useRef(dimension)
  useEffect(() => {
    if (previousDimension.current !== dimension) {
      previousDimension.current = dimension
      setLegend(null)
      setLegendItems([])
    }
  }, [dimension])
  // Filters stay shared across tabs and units; only the page resets when their context changes.
  useEffect(() => {
    setOffset(0)
  }, [analyzed.startUnix, analyzed.endUnix, filters, tableFilters, tableDim])
  useEffect(() => {
    if (top.data && offset > 0 && offset >= top.data.matchedRows)
      setOffset(Math.max(0, Math.floor((top.data.matchedRows - 1) / 8) * 8))
  }, [top.data, offset])
  useEffect(() => {
    const changed = () => {
      setFullscreen(document.fullscreenElement === root.current)
    }
    const escape = (e: KeyboardEvent) => {
      if (
        e.key === 'Escape' &&
        !document.fullscreenElement &&
        !document.querySelector('dialog[open]')
      )
        setFullscreen(false)
    }
    document.addEventListener('fullscreenchange', changed)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('fullscreenchange', changed)
      document.removeEventListener('keydown', escape)
    }
  }, [])
  const toggleFullscreen = async () => {
    if (fullscreen) {
      if (document.fullscreenElement) await document.exitFullscreen()
      setFullscreen(false)
    } else {
      try {
        if (!root.current?.requestFullscreen) throw new Error('unsupported')
        await root.current.requestFullscreen()
      } catch {
        setFullscreen(true)
      }
    }
  }
  const addFilter = useCallback((dim: Dimension, value: string) => {
    setGlobalFilters((fs) => [
      ...fs.filter((f) => f.dimension !== dim),
      { dimension: dim, values: [value] },
    ])
  }, [])
  const rawLevel = !top.data || top.data.level === 'raw'
  const loading =
    overview.loading ||
    detail.loading ||
    totals.loading ||
    top.loading ||
    profile.loading
  const errors = [
    ...new Set(
      [
        targets.error,
        status.error,
        overview.error,
        detail.error,
        totals.error,
        view === 'profile' ? profile.error : null,
      ].filter(Boolean),
    ),
  ]
  return (
    <div
      ref={root}
      className={`page focus-dashboard ${fullscreen ? 'dashboard-fullscreen' : ''}`}
    >
      <TopBar
        targets={targets.data ?? []}
        targetId={targetId}
        status={status.data}
        onChange={onTargetChange}
      />
      <Controls
        period={period}
        onPeriod={(p) => {
          setPeriod(p)
          setFocus({ start: 0.65, end: 1 })
          setAnalysis(FULL)
          reload()
        }}
        dimension={dimension}
        onDimension={(d) => {
          setLegend(null)
          setLegendItems([])
          onDimensionChange(d)
        }}
        refresh={refresh}
        onRefresh={setRefresh}
        onReload={reload}
        loading={loading}
        onFullscreen={toggleFullscreen}
        fullscreen={fullscreen}
      />
      {errors.map((e) => (
        <div className="error" role="alert" key={e}>
          {e}{' '}
          <button type="button" className="link" onClick={reload}>
            Повторить
          </button>
        </div>
      ))}
      {!targets.loading && !targets.data?.length && !targets.error && (
        <div className="card muted">
          Добавьте <a href="#/targets">объект мониторинга</a>, чтобы увидеть
          активность.
        </div>
      )}
      <div className="focus-summary grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div aria-busy={totals.loading}>
          <span>Средняя активность</span>
          <strong>{totals.loading ? <Skeleton /> : totals.data?.average.toFixed(2) ?? '—'}</strong>
          <small>{totals.loading ? <Skeleton /> : 'AAS'}</small>
        </div>
        <div aria-busy={totals.loading}>
          <span>Пик по снимкам</span>
          <strong>
            {totals.loading ? <Skeleton /> : totals.data?.values.length
              ? Math.max(...totals.data.values).toFixed(2)
              : '—'}
          </strong>
          <small>{totals.loading ? <Skeleton wide /> : <>AAS · шаг {totals.data?.stepSeconds ?? '—'} с</>}</small>
        </div>
        <div aria-busy={totals.loading}>
          <span>Интервал анализа</span>
          <strong>
            {totals.loading ? <Skeleton /> : Math.round(((analyzed.endUnix - analyzed.startUnix) / 60) * 10) /
              10}
          </strong>
          <small>{totals.loading ? <Skeleton /> : 'минут'}</small>
        </div>
        <div aria-busy={status.loading}>
          <span>Последний снимок</span>
          <strong>
            {status.loading ? <Skeleton wide /> : status.data?.lastSampleAt
              ? rangeLabel({
                  startUnix: status.data.lastSampleAt,
                  endUnix: status.data.lastSampleAt,
                }).split(' — ')[0]
              : '—'}
          </strong>
          <small>{status.loading ? <Skeleton /> : top.data?.level ?? '—'}</small>
        </div>
      </div>
      <section
        className="card focus-charts"
        aria-label="Графики активности"
        aria-busy={overview.loading || detail.loading}
      >
        <div className="overview-block">
          <div className="chart-heading">
            <h2>Обзор периода</h2>
            <span className="muted">
              AAS · перетаскивайте окно или его края
            </span>
            <span className="range-caption">{rangeLabel(range)}</span>
          </div>
          <BrushChart
            label="Обзор"
            loading={overview.loading}
            mode={chartMode}
            data={overview.data}
            range={range}
            selection={focus}
            onChange={setFocus}
            dimension={dimension}
            compact
          />
        </div>
        <section className="dashboard-filter-row" aria-label="Фильтры дашборда">
          <div className="filters"><span className="data-filter-label">Фильтры данных</span>
            {!globalFilters.length && !legend && (
              <span className="muted">Без фильтров</span>
            )}
            {globalFilters.map((f, i) => (
              <span className="chip" key={f.dimension}>
                <span>
                  {DIMENSIONS.find((d) => d.key === f.dimension)?.label ??
                    f.dimension}
                  : {f.values.join(', ')}
                </span>
                <button
                  type="button"
                  className="chip-x"
                  aria-label={`Убрать общий фильтр ${f.dimension}`}
                  onClick={() =>
                    setGlobalFilters((fs) => fs.filter((_, j) => i !== j))
                  }
                >
                  ×
                </button>
              </span>
            ))}
            {legend && (
              <span className="chip">
                Легенда: {legend}
                <button
                  type="button"
                  className="chip-x"
                  aria-label="Сбросить легенду"
                  onClick={() => setLegend(null)}
                >
                  ×
                </button>
              </span>
            )}
            {(globalFilters.length > 0 || legend) && (
              <button
                type="button"
                className="link"
                onClick={() => {
                  setGlobalFilters([])
                  setLegend(null)
                }}
              >
                Сбросить всё
              </button>
            )}
          </div>
          <div className="chart-options">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={totalOnly}
                onChange={(e) => setTotalOnly(e.target.checked)}
              />
              Только всего
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={background}
                onChange={(e) => setBackground(e.target.checked)}
              />
              Фоновые процессы
            </label>
          </div>
        </section>
        <div className="detail-block">
          <div className="detail-title-row">
            <h2>
              <span className="detail-mark" />
              Анализ активности <small>AAS</small>
            </h2>
            <div className="chart-view-controls">
              <div className="view-toggle chart-mode-toggle" role="group" aria-label="Отображение графиков">
                {(['smooth', 'snapshots'] as const).map(mode => (
                  <button key={mode} type="button" aria-pressed={chartMode === mode}
                    className={`btn small ${chartMode === mode ? 'active' : ''}`}
                    onClick={() => setChartMode(mode)}>
                    {mode === 'smooth' ? 'Плавно' : 'По снимкам'}
                  </button>
                ))}
              </div>
              <div
                className="view-toggle"
                role="group"
                aria-label="Вид активности"
              >
                <button
                  type="button"
                  className={`btn small ${view === 'chart' ? 'active' : ''}`}
                  onClick={() => setView('chart')}
                >
                  График
                </button>
                <button
                  type="button"
                  className={`btn small ${view === 'profile' ? 'active' : ''}`}
                  onClick={() => setView('profile')}
                >
                  Профиль
                </button>
              </div>
            </div>
          </div>
          <div className="detail-toolbar">
            <strong className="range-caption">{rangeLabel(win)}</strong>
            <div className="focus-legend" aria-label="Легенда графика">
              <span className="total-line-label">━ Всего</span>
              {legendItems.map((s) => (
                <button
                  type="button"
                  key={s.value}
                  className={`legend-item ${legend && legend !== s.value ? 'dimmed' : ''}`}
                  aria-pressed={legend === s.value}
                  disabled={s.remainder}
                  title={
                    s.remainder ? 'Остальные значения объединены' : s.label
                  }
                  onClick={() =>
                    setLegend((v) => (v === s.value ? null : s.value))
                  }
                >
                  <span className="sw" style={{ background: s.color }} />
                  <span className="legend-text">{s.label}</span>
                </button>
              ))}
            </div>
          </div>
          {view === 'profile' ? (
            <>
              <DimensionOrder
                order={profileOrder}
                onChange={setProfileOrder}
                rawLevel={rawLevel}
              />
              <ProfileView
                key={profileOrder.join(',')}
                data={profile.data}
                dimensions={profileOrder}
                onQuery={setQueryHash}
                onFilter={addFilter}
              />
            </>
          ) : (
            <BrushChart
              label="Анализ"
              loading={detail.loading}
              mode={chartMode}
              data={detail.data}
              range={win}
              selection={analysis}
              onChange={setAnalysis}
              dimension={dimension}
              totalOnly={totalOnly}
            />
          )}

        </div>
      </section>
      <TopTable
        dimension={tableDim}
        onDimension={setTableDim}
        data={top.data}
        error={top.error}
        loading={top.loading}
        unit={unit}
        onUnit={setUnit}
        onFilter={addFilter}
        onQueryText={setQueryHash}
        rawLevel={rawLevel}
        filters={tableFilters}
        onFilters={setTableFilters}
        offset={offset}
        onOffset={setOffset}
        pageSize={8}
      />
      <QueryModal
        targetId={targetId}
        hash={queryHash}
        onClose={() => setQueryHash(null)}
        onFilter={(hash) => addFilter('QUERY', hash)}
      />
    </div>
  )
}
