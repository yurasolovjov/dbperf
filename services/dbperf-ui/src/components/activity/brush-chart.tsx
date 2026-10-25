import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import type { Dimension, TimeRange, TimeSeriesResponse } from '../../api/types'
import { sliceCssColor as sliceColor } from '../../lib/colors'
import { bucketAreaPath } from './chart-paths'
import {
  clampSelection,
  moveSelection,
  rangeLabel,
  type Selection,
} from './range-model'
interface Props {
  data: TimeSeriesResponse | null
  range: TimeRange
  selection: Selection
  onChange: (s: Selection) => void
  dimension: Dimension
  compact?: boolean
  totalOnly?: boolean
  label: string
}
const L = 36,
  R = 12,
  T = 8,
  B = 24
export function BrushChart({
  data,
  range,
  selection,
  onChange,
  dimension,
  compact,
  totalOnly,
  label,
}: Props) {
  const plotRef = useRef<HTMLDivElement>(null)
  const [{ width: W, height: H }, setSize] = useState({
    width: 1000,
    height: 160,
  })
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0)
        setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        })
    })
    if (plotRef.current) observer.observe(plotRef.current)
    return () => observer.disconnect()
  }, [])
  const track = useRef<HTMLDivElement>(null)
  const drag = useRef<{
    x: number
    selection: Selection
    mode: 'move' | 'start' | 'end' | 'new'
    preview?: Selection
  } | null>(null)
  const [preview, setPreview] = useState<Selection | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const current = preview ?? selection
  const max = Math.max(0.1, ...(data?.totals ?? [])) * 1.08
  const span = range.endUnix - range.startUnix
  const y = (v: number) => T + (1 - v / max) * (H - T - B)
  const x = (t: number) => L + ((t - range.startUnix) / span) * (W - L - R)
  function path(values: number[]) {
    let result = ''
    data?.timestamps.forEach((t, i) => {
      const previous = data.timestamps[i - 1]
      const gap = i === 0 || t - previous > data.stepSeconds * 1.5
      if (!gap) result += ` H${x(t).toFixed(1)}`
      result += `${gap ? ' M' : ' L'}${x(t).toFixed(1)},${y(values[i] ?? 0).toFixed(1)}`
      // A sample is a bucket, so keep it visible until its right edge.
      if (
        i === data.timestamps.length - 1 ||
        data.timestamps[i + 1] - t > data.stepSeconds * 1.5
      )
        result += ` H${x(Math.min(range.endUnix, t + data.stepSeconds)).toFixed(1)}`
    })
    return result
  }
  const accumulated = (data?.timestamps ?? []).map(() => 0)
  const bands = (data?.series ?? []).map((series) => {
    const bottom = [...accumulated]
    const top = accumulated.map((_, i) => accumulated[i] += series.values[i] ?? 0)
    return {
      key: series.slice.value,
      color: sliceColor(dimension, series.slice),
      area: bucketAreaPath(data!.timestamps, top, bottom, data!.stepSeconds, range.endUnix, x, y),
      line: path(top),
    }
  })
  const coordinate = (e: PointerEvent) => {
    const r = track.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
  }
  const down = (e: PointerEvent, mode: 'move' | 'start' | 'end' | 'new') => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: coordinate(e), selection, mode }
  }
  const move = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    const delta = coordinate(e) - d.x
    d.preview =
      d.mode === 'new'
        ? clampSelection({
            start: Math.min(d.x, d.x + delta),
            end: Math.max(d.x, d.x + delta),
          })
        : moveSelection(d.selection, d.mode, delta)
    setPreview(d.preview)
  }
  const up = () => {
    if (drag.current?.preview) onChange(drag.current.preview)
    setPreview(null)
    drag.current = null
  }
  const key = (e: KeyboardEvent, mode: 'move' | 'start' | 'end') => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    e.stopPropagation()
    const delta =
      e.key === 'Home'
        ? -1
        : e.key === 'End'
          ? 1
          : (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01)
    onChange(moveSelection(selection, mode, delta))
  }
  const zoom = (factor: number) => {
    const mid = (selection.start + selection.end) / 2,
      half = ((selection.end - selection.start) * factor) / 2
    onChange(clampSelection({ start: mid - half, end: mid + half }))
  }
  const hovered =
    hover === null || !data?.timestamps.length
      ? -1
      : data.timestamps.reduce(
          (best, t, i) =>
            Math.abs(t - (range.startUnix + hover * span)) <
            Math.abs(data.timestamps[best] - (range.startUnix + hover * span))
              ? i
              : best,
          0,
        )
  return (
    <div>
      <div
        ref={plotRef}
        className={`focus-plot ${compact ? 'overview-plot' : 'detail-plot'}`}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
        >
          {(compact ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map((v) => (
            <g key={v}>
              <line
                x1={L}
                x2={W - R}
                y1={y(max * v)}
                y2={y(max * v)}
                stroke="var(--chart-grid)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={L - 5}
                y={y(max * v) + 3}
                textAnchor="end"
                fill="var(--muted)"
                fontSize="9"
              >
                {(max * v).toFixed(1)}
              </text>
            </g>
          ))}
          {!totalOnly && bands.map((band) => (
            <path key={`area-${band.key}`} className="series-area" d={band.area}
              fill={band.color} fillOpacity={compact ? 0.65 : 0.55} stroke="none" />
          ))}
          {!totalOnly && !compact && bands.map((band) => (
            <path key={`line-${band.key}`} d={band.line} fill="none" stroke={band.color}
              strokeWidth="1.3" vectorEffect="non-scaling-stroke" />
          ))}
          <path
            d={path(data?.totals ?? [])}
            fill="none"
            stroke="var(--chart-total)"
            strokeWidth={compact ? '1.5' : '2.2'}
            vectorEffect="non-scaling-stroke"
          />
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <text
              key={v}
              x={L + v * (W - L - R)}
              y={H - 5}
              textAnchor={v === 0 ? 'start' : v === 1 ? 'end' : 'middle'}
              fontSize="9"
              fill="var(--muted)"
            >
              {
                rangeLabel({
                  startUnix: range.startUnix + v * span,
                  endUnix: range.endUnix,
                }).split(' — ')[0]
              }
            </text>
          ))}
        </svg>
        {!data?.timestamps.length && (
          <div className="chart-empty">Нет снимков за выбранный период</div>
        )}
        <div
          ref={track}
          className="brush-track"
          onPointerDown={(e) => down(e, 'new')}
          onPointerMove={(e) => {
            move(e)
            setHover(coordinate(e))
          }}
          onPointerUp={up}
          onPointerCancel={() => {
            setPreview(null)
            drag.current = null
          }}
          onPointerLeave={() => setHover(null)}
        >
          <div
            className="brush-window"
            style={{
              left: `${current.start * 100}%`,
              width: `${(current.end - current.start) * 100}%`,
            }}
            tabIndex={0}
            role="group"
            aria-label={`${label}: переместить окно`}
            onPointerDown={(e) => down(e, 'move')}
            onKeyDown={(e) => key(e, 'move')}
          >
            <button
              type="button"
              className="brush-handle start"
              aria-label={`${label}: начало окна`}
              onPointerDown={(e) => down(e, 'start')}
              onKeyDown={(e) => key(e, 'start')}
            >
              <span />
            </button>
            <button
              type="button"
              className="brush-handle end"
              aria-label={`${label}: конец окна`}
              onPointerDown={(e) => down(e, 'end')}
              onKeyDown={(e) => key(e, 'end')}
            >
              <span />
            </button>
          </div>
        </div>
        {hovered >= 0 && !drag.current && (
          <div className="plot-tooltip">
            {
              rangeLabel({
                startUnix: data!.timestamps[hovered],
                endUnix: data!.timestamps[hovered],
              }).split(' — ')[0]
            }{' '}
            · {data!.totals[hovered].toFixed(2)} AAS
          </div>
        )}
      </div>
      <div
        className="brush-actions"
        role="group"
        aria-label={`${label}: управление окном`}
      >
        <button
          type="button"
          aria-label={`${label}: сдвинуть влево`}
          onClick={() => onChange(moveSelection(selection, 'move', -0.05))}
        >
          ‹
        </button>
        <button
          type="button"
          aria-label={`${label}: уменьшить окно`}
          onClick={() => zoom(0.8)}
        >
          −
        </button>
        <span>{Math.round((selection.end - selection.start) * 100)}%</span>
        <button
          type="button"
          aria-label={`${label}: увеличить окно`}
          onClick={() => zoom(1.25)}
        >
          +
        </button>
        <button
          type="button"
          aria-label={`${label}: сдвинуть вправо`}
          onClick={() => onChange(moveSelection(selection, 'move', 0.05))}
        >
          ›
        </button>
        <button
          type="button"
          className="link"
          onClick={() => onChange({ start: 0, end: 1 })}
        >
          Весь интервал
        </button>
      </div>
    </div>
  )
}
