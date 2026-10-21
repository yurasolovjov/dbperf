import { useMemo } from 'react'
import type { Data, Layout, PlotSelectionEvent, Shape } from 'plotly.js'
import type { Dimension, TimeRange, TimeSeriesResponse } from '../api/types'
import { sliceColor } from '../lib/colors'
import { sliceLabel } from '../lib/format'
import { chartFont, Plot, plotTime } from '../lib/plot'

interface Props {
  data: TimeSeriesResponse | null
  dimension: Dimension
  height: number
  totalOnly?: boolean
  window?: TimeRange | null // highlighted on the overview chart
  onWindow?: (w: TimeRange) => void
  onLegendClick?: (value: string) => void
  tickSeconds?: boolean
  emptyText?: string
}

// ActivityChart draws a stacked area of average active sessions per bucket.
// With onWindow set, a horizontal box selection becomes the sliding window.
export function ActivityChart({ data, dimension, height, totalOnly, window, onWindow, onLegendClick, tickSeconds, emptyText }: Props) {
  const { traces, layout } = useMemo(() => {
    const x = (data?.timestamps ?? []).map(plotTime)
    const traces: Partial<Data>[] = []
    if (data) {
      if (totalOnly) {
        traces.push({
          type: 'scatter',
          mode: 'lines',
          name: 'Общая активность',
          x,
          y: data.totals,
          fill: 'tozeroy',
          line: { color: '#2a78d6', width: 1.5 },
          fillcolor: 'rgba(42,120,214,0.25)',
          hovertemplate: '%{y:.2f} сессий<extra>всего</extra>',
        })
      } else {
        for (const s of data.series) {
          const color = sliceColor(dimension, s.slice)
          traces.push({
            type: 'scatter',
            mode: 'lines',
            name: sliceLabel(dimension, s.slice),
            x,
            y: s.values,
            stackgroup: 'one',
            line: { color, width: 0.5 },
            fillcolor: color,
            hovertemplate: `%{y:.2f}<extra>${escapeHtml(sliceLabel(dimension, s.slice))}</extra>`,
            meta: s.slice.value,
          })
        }
      }
    }
    const shapes: Partial<Shape>[] = []
    if (window && data) {
      const x0 = plotTime(window.startUnix)
      const x1 = plotTime(window.endUnix)
      shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0, x1, y0: 0, y1: 1, fillcolor: 'rgba(60,60,60,0.12)', line: { width: 0 } })
      shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0, x1: x0, y0: 0, y1: 1, line: { color: '#333', width: 1.5 } })
      shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: x1, x1, y0: 0, y1: 1, line: { color: '#333', width: 1.5 } })
    }
    const layout: Partial<Layout> = {
      height,
      margin: { l: 44, r: 8, t: 8, b: 32 },
      font: chartFont,
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: '#fff',
      showlegend: !totalOnly,
      legend: { orientation: 'v', x: 1.01, y: 1, xanchor: 'left', font: { size: 12 }, itemclick: onLegendClick ? false : 'toggle', itemdoubleclick: false },
      hovermode: 'x unified',
      dragmode: onWindow ? 'select' : false,
      selectdirection: 'h',
      xaxis: {
        type: 'date',
        tickformat: tickSeconds ? '%H:%M:%S' : '%H:%M',
        gridcolor: '#eee',
        zeroline: false,
        fixedrange: true,
      },
      yaxis: { title: { text: 'Сессии', standoff: 6 }, rangemode: 'tozero', gridcolor: '#eee', zeroline: false, fixedrange: true },
      shapes,
      annotations:
        traces.length === 0
          ? [{ text: emptyText ?? 'Нет данных за период', xref: 'paper', yref: 'paper', x: 0.5, y: 0.5, showarrow: false, font: { color: '#999' } }]
          : [],
    }
    return { traces, layout }
  }, [data, dimension, height, totalOnly, window, onWindow, onLegendClick, tickSeconds, emptyText])

  return (
    <Plot
      data={traces}
      layout={layout}
      config={{ displayModeBar: false, responsive: true, scrollZoom: false }}
      style={{ width: '100%' }}
      useResizeHandler
      onSelected={(e: PlotSelectionEvent) => {
        if (!onWindow || !e?.range?.x) return
        const [a, b] = e.range.x as (string | number)[]
        const s = Math.floor(new Date(String(a).replace(' ', 'T')).getTime() / 1000)
        const t = Math.floor(new Date(String(b).replace(' ', 'T')).getTime() / 1000)
        if (Number.isFinite(s) && Number.isFinite(t) && t > s) onWindow({ startUnix: s, endUnix: t })
      }}
      onLegendClick={(e) => {
        if (!onLegendClick) return true
        const meta = (e.data[e.curveNumber] as Partial<Data> & { meta?: string }).meta
        if (typeof meta === 'string') onLegendClick(meta)
        return false
      }}
    />
  )
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
