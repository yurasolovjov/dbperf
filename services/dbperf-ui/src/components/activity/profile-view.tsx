import { useMemo, useState } from 'react'
import type { Dimension, ProfileResponse } from '../../api/types'
import { DIMENSIONS } from '../../api/client'
import { hashCssColor as hashColor, waitCssColor as waitTypeColor } from '../../lib/colors'
interface Node {
  value: string
  samples: number
  children: Map<string, Node>
}
interface Props {
  data: ProfileResponse | null
  dimensions: Dimension[]
  onQuery: (hash: string) => void
  onFilter: (dim: Dimension, value: string) => void
}
export function ProfileView({ data, dimensions, onQuery, onFilter }: Props) {
  const [visible, setVisible] = useState(100)
  const [rootPath, setRootPath] = useState<string[]>([])
  const root = useMemo(() => {
    const root: Node = {
      value: 'Вся активность',
      samples: data?.totalSamples ?? 0,
      children: new Map(),
    }
    for (const p of data?.paths ?? []) {
      let node = root
      p.values.forEach((v) => {
        if (!node.children.has(v))
          node.children.set(v, { value: v, samples: 0, children: new Map() })
        node = node.children.get(v)!
        node.samples += p.samples
      })
    }
    return root
  }, [data])
  let current = root
  let depth = 0
  for (const value of rootPath) {
    const child = current.children.get(value)
    if (!child) break
    current = child
    depth++
  }
  const dim = dimensions[depth]
  const nodes = [...current.children.values()].sort(
    (a, b) => b.samples - a.samples || a.value.localeCompare(b.value),
  )
  const covered = (data?.paths ?? []).reduce((sum, p) => sum + p.samples, 0)
  if (!data?.totalSamples)
    return (
      <div className="profile-empty muted">Нет активности в выбранном окне</div>
    )
  return (
    <div className="profile-view">
      <div className="profile-breadcrumb">
        <button
          type="button"
          className="link"
          onClick={() => {
            setRootPath([])
            setVisible(100)
          }}
        >
          Вся активность
        </button>
        {rootPath.slice(0, depth).map((v, i) => (
          <button
            type="button"
            className="link"
            key={i}
            onClick={() => {
              setRootPath(rootPath.slice(0, i + 1))
              setVisible(100)
            }}
          >
            {' '}
            /{' '}
            {dimensions[i] === 'QUERY'
              ? (data.queryShortTexts[v] ?? `#${v}`)
              : v}
          </button>
        ))}
      </div>
      {dim ? (
        <>
          <div className="profile-level-label">
            {DIMENSIONS.find((d) => d.key === dim)?.label}{' '}
            <span>
              Доля от всей активности · клик —{' '}
              {dim === 'QUERY' ? 'открыть SQL' : 'раскрыть уровень'}
            </span>
          </div>
          <div className="profile-query-row">
            {nodes.slice(0, visible).map((n) => {
              const color =
                dim === 'WAIT_EVENT_TYPE' || dim === 'WAIT_EVENT'
                  ? waitTypeColor(n.value.split('.')[0])
                  : hashColor(n.value)
              return (
                <div
                  key={n.value}
                  className="profile-node"
                  style={{
                    flexGrow: Math.max(1, n.samples),
                    borderColor: `color-mix(in srgb, ${color} 40%, var(--border))`,
                    background: `color-mix(in srgb, ${color} 12%, var(--card))`,
                  }}
                >
                  <button
                    type="button"
                    className="profile-node-main"
                    title={
                      dim === 'QUERY' ? data.queryShortTexts[n.value] : n.value
                    }
                    onClick={() => {
                      if (dim === 'QUERY') onQuery(n.value)
                      else if (n.children.size) {
                        setRootPath([...rootPath.slice(0, depth), n.value])
                        setVisible(100)
                      } else onFilter(dim, n.value)
                    }}
                  >
                    <span>
                      {dim === 'QUERY'
                        ? (data.queryShortTexts[n.value] ?? `#${n.value}`)
                        : n.value || '(пусто)'}
                    </span>
                    <small>
                      {((100 * n.samples) / data.totalSamples).toFixed(1)}%
                    </small>
                  </button>
                  {n.children.size > 0 && dim === 'QUERY' && (
                    <button
                      type="button"
                      className="profile-node-action"
                      aria-label={`Раскрыть запрос ${n.value}`}
                      onClick={() => {
                        setRootPath([...rootPath.slice(0, depth), n.value])
                        setVisible(100)
                      }}
                    >
                      ›
                    </button>
                  )}
                  <button
                    type="button"
                    className="profile-node-action"
                    aria-label={`В фильтры: ${n.value}`}
                    onClick={() => onFilter(dim, n.value)}
                  >
                    +
                  </button>
                </div>
              )
            })}
          </div>
          {nodes.length > visible && (
            <button
              type="button"
              className="btn"
              onClick={() => setVisible((v) => v + 100)}
            >
              Показать ещё {Math.min(100, nodes.length - visible)} из{' '}
              {nodes.length - visible}
            </button>
          )}
        </>
      ) : (
        <div className="muted">
          Конец профиля ·{' '}
          {(current.samples / Math.max(1, data.nSamples)).toFixed(2)} AAS
        </div>
      )}
      {covered < data.totalSamples && (
        <div className="hint muted">
          За пределами выдачи профиля:{' '}
          {(((data.totalSamples - covered) / data.totalSamples) * 100).toFixed(
            1,
          )}
          % активности
        </div>
      )}
    </div>
  )
}
