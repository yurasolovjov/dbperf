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
  // Stepped lines hold a bucket's value until the next bucket: honest for the
  // detail chart, where a point is a single snapshot. The overview averages
  // many snapshots per bucket and reads better as a smooth line.
  stepped?: boolean
}

// ActivityChart draws a stacked area of average active sessions per bucket.
// With onWindow set, a horizontal box selection becomes the sliding window.
export function ActivityChart({ data, dimension, height, totalOnly, window, onWindow, onLegendClick, tickSeconds, emptyText, stepped = true }: Props) {
  const { traces, layout } = useMemo(() => {
    const gapped = data ? withGaps(data) : null
    const x = (gapped?.timestamps ?? []).map(plotTime)
    const traces: Partial<Data>[] = []
    if (gapped) {
      if (totalOnly) {
        traces.push({
          type: 'scatter',
          mode: 'lines',
          name: 'Общая активность',
          x,
          y: gapped.totals,
          fill: 'tozeroy',
          connectgaps: false,
          line: { color: '#2a78d6', width: 1.5, shape: stepped ? 'hv' : 'linear' },
          fillcolor: 'rgba(42,120,214,0.25)',
          hovertemplate: '%{y:.2f} сессий<extra>всего</extra>',
        })
      } else {
        for (const s of gapped.series) {
          const color = sliceColor(dimension, s.slice)
          traces.push({
            type: 'scatter',
            mode: 'lines',
            name: sliceLabel(dimension, s.slice),
            x,
            y: s.values,
            stackgroup: 'one',
            connectgaps: false,
            line: { color, width: 0.5, shape: stepped ? 'hv' : 'linear' },
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
      legend: {
        orientation: 'v',
        x: 1.01,
        y: 1,
        xanchor: 'left',
        font: { size: 12 },
        traceorder: 'reversed', // top of the legend = top of the stack
        itemclick: onLegendClick ? false : 'toggle',
        itemdoubleclick: false,
      },
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
      yaxis: { rangemode: 'tozero', gridcolor: '#eee', zeroline: false, fixedrange: true },
      shapes,
      annotations: [
        // The axis title is an annotation so it can carry a tooltip.
        {
          text: 'СКАС',
          hovertext: 'среднее количество активных сессий',
          captureevents: true,
          textangle: -90,
          xref: 'paper',
          yref: 'paper',
          x: 0,
          y: 0.5,
          xanchor: 'center',
          yanchor: 'middle',
          xshift: -34,
          showarrow: false,
          font: { size: 12, color: '#444' },
        },
        ...(traces.length === 0
          ? [{ text: emptyText ?? 'Нет данных за период', xref: 'paper' as const, yref: 'paper' as const, x: 0.5, y: 0.5, showarrow: false, font: { color: '#999' } }]
          : []),
      ],
    }
    return { traces, layout }
  }, [data, dimension, height, totalOnly, window, onWindow, onLegendClick, tickSeconds, emptyText, stepped])

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

// withGaps inserts a null point one step after every bucket that is not
// followed by the next bucket: the server drops buckets without snapshots, and
// without the null Plotly would draw a straight line across the collection gap.
// The null also ends the 'hv' step of the last bucket before the gap.
function withGaps(d: TimeSeriesResponse): TimeSeriesResponse {
  const ts = d.timestamps
  const step = d.stepSeconds
  const holes: number[] = [] // indexes in ts after which a null point goes
  for (let i = 0; i + 1 < ts.length; i++) if (ts[i + 1] - ts[i] > step) holes.push(i)
  if (holes.length === 0) return d
  const timestamps: number[] = []
  const totals: (number | null)[] = []
  const series = d.series.map((s) => ({ ...s, values: [] as (number | null)[] }))
  let h = 0
  for (let i = 0; i < ts.length; i++) {
    timestamps.push(ts[i])
    totals.push(d.totals[i])
    series.forEach((s, k) => s.values.push(d.series[k].values[i]))
    if (h < holes.length && holes[h] === i) {
      h++
      timestamps.push(ts[i] + step)
      totals.push(null)
      series.forEach((s) => s.values.push(null))
    }
  }
  return { ...d, timestamps, totals: totals as number[], series: series as TimeSeriesResponse['series'] }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
