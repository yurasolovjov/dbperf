export function ChartLoader({ label }: { label: string }) {
  return (
    <div className="chart-progress" role="status" aria-label={`${label}: загрузка данных`}>
      <span className="chart-progress-line" aria-hidden="true" />
      <span className="chart-progress-label">Обновляем график…</span>
    </div>
  )
}
