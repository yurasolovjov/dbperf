import { useMemo } from 'react'
import type { Data, Layout, PlotMouseEvent } from 'plotly.js'
import type { Dimension, ProfileResponse } from '../api/types'
import { DIMENSIONS } from '../api/client'
import { hashColor, waitTypeColor } from '../lib/colors'
import { chartFont, Plot } from '../lib/plot'

interface Props {
  data: ProfileResponse | null
  dimensions: Dimension[]
  tickSeconds: number
  onFilter: (dimension: Dimension, value: string) => void
  onQueryText: (hash: string) => void
}

interface Node {
  id: string
  parent: string
  label: string
  value: number
  color: string
  dim: Dimension | null
  raw: string
}

const ROOT = 'root'

// FlameGraph renders the window profile as a Plotly icicle: root on top, one
// row per dimension, width = share of samples. Click zooms into a node,
// Ctrl/Cmd-click adds a filter on it, Shift-click on a query opens its text.
export function FlameGraph({ data, dimensions, tickSeconds, onFilter, onQueryText }: Props) {
  const { trace, layout, nodes } = useMemo(() => {
    const nodes = new Map<string, Node>()
    const total = data?.totalSamples ?? 0
    nodes.set(ROOT, { id: ROOT, parent: '', label: 'всё', value: total, color: '#e3e5e8', dim: null, raw: '' })
    let covered = 0
    for (const p of data?.paths ?? []) {
      covered += p.samples
      let parent = ROOT
      let waitType = ''
      for (let i = 0; i < dimensions.length; i++) {
        const dim = dimensions[i]
        const raw = p.values[i] ?? ''
        const id = `${parent}/${i}:${raw}`
        if (dim === 'WAIT_EVENT_TYPE') waitType = raw
        if (dim === 'WAIT_EVENT') waitType = raw.split('.')[0]
        let n = nodes.get(id)
        if (!n) {
          n = { id, parent, label: labelOf(dim, raw, data?.queryShortTexts), value: 0, color: colorOf(dim, raw, waitType), dim, raw }
          nodes.set(id, n)
        }
        n.value += p.samples
        parent = id
      }
    }
    if (total > covered) {
      nodes.set(`${ROOT}/other`, { id: `${ROOT}/other`, parent: ROOT, label: 'other', value: total - covered, color: waitTypeColor('other'), dim: null, raw: '' })
    }
    const list = [...nodes.values()]
    const nSamples = data?.nSamples ?? 0
    const trace: Partial<Data> = {
      type: 'icicle',
      ids: list.map((n) => n.id),
      labels: list.map((n) => n.label),
      parents: list.map((n) => n.parent),
      values: list.map((n) => n.value),
      branchvalues: 'total',
      marker: { colors: list.map((n) => n.color), line: { width: 1, color: '#fff' } },
      tiling: { orientation: 'v', flip: '' },
      pathbar: { visible: true, side: 'top', thickness: 18 },
      textfont: { size: 11 },
      customdata: list.map((n) => [n.value, nSamples > 0 ? n.value / nSamples : 0, total > 0 ? (100 * n.value) / total : 0, n.value * tickSeconds]),
      hovertemplate:
        '%{label}<br>снимков: %{customdata[0]}<br>СКАС: %{customdata[1]:.2f}<br>доля: %{customdata[2]:.1f} %<br>session-seconds: %{customdata[3]}<extra></extra>',
    } as Partial<Data>
    const layout: Partial<Layout> = {
      height: 40 + (dimensions.length + 1) * 46,
      margin: { l: 4, r: 4, t: 4, b: 4 },
      font: chartFont,
      paper_bgcolor: 'rgba(0,0,0,0)',
    }
    return { trace, layout, nodes }
  }, [data, dimensions, tickSeconds])

  if (!data || data.totalSamples === 0) {
    return <div className="muted center" style={{ padding: '2rem 0' }}>Нет активных сессий в окне</div>
  }

  return (
    <div>
      <div className="flame-levels">
        {dimensions.map((d, i) => (
          <span key={d} className="muted">
            {i + 1}. {DIMENSIONS.find((x) => x.key === d)?.label ?? d}
          </span>
        ))}
      </div>
      <Plot
        data={[trace]}
        layout={layout}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: '100%' }}
        useResizeHandler
        onClick={(e: PlotMouseEvent) => {
          const pt = e.points?.[0] as unknown as { id?: string } | undefined
          const n = pt?.id ? nodes.get(pt.id) : undefined
          if (!n || !n.dim) return
          const ev = e.event as MouseEvent
          if (ev?.shiftKey && n.dim === 'QUERY') onQueryText(n.raw)
          else if (ev?.ctrlKey || ev?.metaKey) onFilter(n.dim, n.raw)
        }}
      />
      <div className="hint muted">Клик — приблизить узел, Ctrl/⌘-клик — добавить фильтр, Shift-клик по запросу — показать текст</div>
    </div>
  )
}

function labelOf(dim: Dimension, raw: string, texts?: Record<string, string>): string {
  if (dim === 'QUERY') return texts?.[raw] || `#${raw}`
  if (dim === 'WAIT_EVENT' && raw === 'CPU') return 'CPU'
  return raw || '(пусто)'
}

function colorOf(dim: Dimension, raw: string, waitType: string): string {
  if (dim === 'WAIT_EVENT_TYPE' || dim === 'WAIT_EVENT') return waitTypeColor(waitType)
  if (waitType) return waitTypeColor(waitType)
  return hashColor(raw)
}
