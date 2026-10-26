import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import type { Dimension, ProfileResponse } from '../../api/types'
import { DIMENSIONS } from '../../api/client'
import { waitCssColor } from '../../lib/colors'
import {
  buildTree,
  collapse,
  COLLAPSE_SHARE,
  find,
  layout,
  nodeLabel,
  pathOf,
  searchMatches,
  waitTypeOf,
  type FlameNode,
} from './flame-model'

interface Props {
  data: ProfileResponse | null
  dimensions: Dimension[]
  onQuery: (hash: string) => void
  onFilter: (dim: Dimension, value: string) => void
  loading?: boolean
}

const ROW = 26
const GAP = 3
const LABEL_MIN_WIDTH = 0.03 // boxes narrower than 3 % carry no text

// FlameGraph draws the activity profile as an icicle: one row per dimension
// level, width = share of snapshots. As in pprof, a click focuses the node:
// it becomes the top row, only its descendants stay, the breadcrumb leads
// back and Escape returns to the whole window.
export function FlameGraph({ data, dimensions, onQuery, onFilter, loading }: Props) {
  const [rootPath, setRootPath] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [folded, setFolded] = useState(true)
  const [hover, setHover] = useState<{ node: FlameNode; left: number; width: number } | null>(null)

  const total = data?.totalSamples ?? 0
  const snapshots = Math.max(1, data?.nSamples ?? 0)
  const tree = useMemo(() => {
    if (!data || !data.totalSamples) return null
    const full = buildTree(data)
    return folded ? collapse(full, data.totalSamples * COLLAPSE_SHARE) : full
  }, [data, folded])

  const label = (n: FlameNode) => nodeLabel(n, dimensions, data?.queryShortTexts ?? {})
  const displayed = (tree && find(tree, rootPath)) ?? tree
  // A root that vanished with new data falls back to the whole window.
  useEffect(() => {
    if (tree && rootPath.length && !find(tree, rootPath)) setRootPath([])
  }, [tree, rootPath])

  const boxes = useMemo(() => (displayed ? layout(displayed) : []), [displayed])
  const ancestors = useMemo(() => {
    const out: FlameNode[] = []
    for (let n = displayed?.parent ?? null; n; n = n.parent) out.unshift(n)
    return out
  }, [displayed])
  const matched = useMemo(() => (tree ? searchMatches(tree, query, label) : []), [tree, query, dimensions, data]) // eslint-disable-line react-hooks/exhaustive-deps
  const matchedSamples = matched.reduce((s, n) => s + n.samples, 0)
  const covered = (data?.paths ?? []).reduce((sum, p) => sum + p.samples, 0)
  const waitTypes = useMemo(() => {
    const seen = new Set<string>()
    const walk = (n: FlameNode) => {
      const t = waitTypeOf(n, dimensions)
      if (t) seen.add(t)
      n.children.forEach(walk)
    }
    if (tree) walk(tree)
    return [...seen]
  }, [tree, dimensions])

  const color = (n: FlameNode): string => {
    if (n.depth === 0) return 'var(--flame-root)'
    if (n.remainder) return 'var(--wait-other)'
    const t = waitTypeOf(n, dimensions)
    if (t) return waitCssColor(t)
    return n.depth % 2 ? 'var(--flame-a)' : 'var(--flame-b)'
  }
  const pct = (n: FlameNode) => (total ? (100 * n.samples) / total : 0)
  const aas = (n: FlameNode) => n.samples / snapshots
  const dimOf = (n: FlameNode): Dimension | undefined => (n.depth ? dimensions[n.depth - 1] : undefined)
  const pathText = (n: FlameNode) => {
    const parts: string[] = []
    for (let x: FlameNode | null = n; x && x.depth > 0; x = x.parent) parts.unshift(label(x))
    return parts.join(' › ')
  }
  const focus = (n: FlameNode) => {
    if (n.remainder) return
    setRootPath(pathOf(n))
    setHover(null)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && rootPath.length) {
      e.stopPropagation()
      setRootPath([])
    }
  }

  if (!data || !tree || !displayed)
    return (
      <div className="flame-empty muted" aria-busy={loading}>
        {loading ? 'Загрузка профиля…' : 'Нет активности в выбранном окне'}
      </div>
    )

  const matchSet = new Set(matched)
  const related = (n: FlameNode) => matched.some((m) => isAncestor(m, n) || isAncestor(n, m))
  // The whole-window root is implied by the breadcrumb, so rows start at
  // level 1; a focused node becomes the top row and its parents are hidden.
  const firstDepth = Math.max(1, displayed.depth)
  const rows = Math.max(1, ...boxes.map((b) => b.node.depth - firstDepth + 1))
  const rowTop = (depth: number) => (depth - firstDepth) * (ROW + GAP)
  const levelName = (depth: number) =>
    DIMENSIONS.find((d) => d.key === dimensions[depth - 1])?.label ?? dimensions[depth - 1] ?? ''

  return (
    <div className="flame-view" onKeyDown={onKey} aria-busy={loading}>
      <div className="flame-toolbar">
        <div className="flame-breadcrumb" aria-label="Корень flame graph">
          <button type="button" className="link" onClick={() => focus(tree)}>
            Вся активность
          </button>
          {ancestors.slice(1).map((n) => (
            <button type="button" className="link" key={n.depth} onClick={() => focus(n)}>
              {' / '}
              {label(n)}
            </button>
          ))}
          {displayed.depth > 0 && (
            <span>
              {' / '}
              <strong>{label(displayed)}</strong>
            </span>
          )}
          <span className="muted">
            {' '}
            · {pct(displayed).toFixed(1)} %, {aas(displayed).toFixed(2)} AAS
          </span>
        </div>
        <label className="flame-search">
          <span className="sr-only">Поиск по узлам</span>
          <input
            type="search"
            placeholder="Поиск по узлам"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query.trim() && (
            <span className="muted">
              {matched.length} узл. · {(total ? (100 * matchedSamples) / total : 0).toFixed(1)} %
            </span>
          )}
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={folded} onChange={(e) => setFolded(e.target.checked)} />
          свернуть &lt; 1 %
        </label>
      </div>
      <div className="flame-body">
        <div className="flame-levels" aria-hidden="true" style={{ height: rows * (ROW + GAP) }}>
          {Array.from({ length: rows }, (_, d) => (
            <span key={d} style={{ top: d * (ROW + GAP), height: ROW }}>
              {levelName(firstDepth + d)}
            </span>
          ))}
        </div>
        <div
          className="flame-plot"
          role="group"
          aria-label="Flame graph активности"
          style={{ height: rows * (ROW + GAP) }}
          onMouseLeave={() => setHover(null)}
        >
          {boxes.filter((b) => b.node.depth > 0).map(({ node, left, width }) => {
            const match = matchSet.has(node)
            const dimmed = query.trim() !== '' && !match && !related(node)
            const isRoot = node === displayed
            return (
              <button
                type="button"
                key={pathOf(node).join('\u0001')}
                className={`flame-node ${node.remainder ? 'rest' : ''} ${isRoot ? 'focused' : ''} ${match ? 'match' : ''} ${dimmed ? 'dimmed' : ''}`}
                data-depth={node.depth}
                style={{
                  left: `${left * 100}%`,
                  width: `${width * 100}%`,
                  top: rowTop(node.depth),
                  height: ROW,
                  ['--flame-color' as string]: color(node),
                }}
                aria-label={`${label(node)}: ${pct(node).toFixed(1)} %`}
                aria-pressed={isRoot}
                onClick={() => focus(node)}
                onMouseEnter={() => setHover({ node, left, width })}
                onFocus={() => setHover({ node, left, width })}
                onBlur={() => setHover(null)}
              >
                {width >= LABEL_MIN_WIDTH && (
                  <span>
                    {label(node)} <small>{pct(node).toFixed(1)} %</small>
                  </span>
                )}
              </button>
            )
          })}
          {hover && (
            <div
              className="flame-tip"
              role="tooltip"
              style={{
                left: `${Math.min(hover.left, 0.6) * 100}%`,
                top: rowTop(hover.node.depth + 1) + 2,
              }}
            >
              <strong>{pathText(hover.node)}</strong>
              <span>
                {pct(hover.node).toFixed(1)} % · {aas(hover.node).toFixed(2)} AAS · {hover.node.samples} снимков
              </span>
            </div>
          )}
        </div>
        <aside className="flame-card" aria-label="Текущий узел">
          <span className="muted">{displayed.depth ? 'Текущий узел' : 'Весь профиль'}</span>
          <strong>{displayed.depth ? pathText(displayed) : label(displayed)}</strong>
          <span>
            {pct(displayed).toFixed(1)} % всей активности
            <br />
            {aas(displayed).toFixed(2)} AAS · {displayed.samples} снимков
          </span>
          <div className="flame-card-actions">
            {displayed.depth > 0 && (
              <button type="button" className="btn small" onClick={() => onFilter(dimOf(displayed)!, displayed.value)}>
                В фильтр дашборда
              </button>
            )}
            {dimOf(displayed) === 'QUERY' && (
              <button type="button" className="btn small" onClick={() => onQuery(displayed.value)}>
                Текст запроса
              </button>
            )}
            {rootPath.length > 0 && (
              <button type="button" className="btn small" onClick={() => focus(tree)}>
                Сбросить
              </button>
            )}
          </div>
        </aside>
      </div>
      <div className="flame-footer muted">
        {waitTypes.length > 0 && (
          <span className="flame-legend">
            Цвет — тип ожидания:
            {waitTypes.map((t) => (
              <span key={t}>
                <i style={{ background: waitCssColor(t) }} /> {t}
              </span>
            ))}
          </span>
        )}
        <span>Ширина — доля снимков. Клик — оставить узел и вложенные, Esc — вся активность.</span>
        {covered < total && (
          <span>За пределами выдачи профиля: {((100 * (total - covered)) / total).toFixed(1)} %</span>
        )}
      </div>
    </div>
  )
}

function isAncestor(a: FlameNode, n: FlameNode): boolean {
  for (let x = n.parent; x; x = x.parent) if (x === a) return true
  return false
}
