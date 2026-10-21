import Plotly from 'plotly.js-dist-min'
import createPlotlyComponent from 'react-plotly.js/factory'

// One Plotly bundle for every chart on the page.
export const Plot = createPlotlyComponent(Plotly)

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// Plotly reads 'YYYY-MM-DD HH:mm:ss' as a calendar time without a zone, so
// local wall-clock strings keep the axis in the viewer's time zone.
export function plotTime(unix: number): string {
  const d = new Date(unix * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export const chartFont = { family: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif', size: 12, color: '#444' }
