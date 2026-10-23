import { useState } from 'react'
import yaml from 'js-yaml'
import { registry, validateInput, type BulkResult, type CreateTargetInput } from '../api/registry'

interface Props {
  onClose: () => void
  onDone: () => void
}

interface Row {
  input: CreateTargetInput
  error: string | null
  result?: BulkResult
}

// parseDuration accepts "10s", "2m", "500ms" or a plain number of seconds.
function parseDuration(v: unknown, unit: 'sec' | 'ms'): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'number') return v
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/)
  if (!m) return NaN
  const n = Number(m[1])
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 }
  const ms = (mult[m[2] ?? 's'] ?? 1000) * n
  return unit === 'ms' ? Math.round(ms) : Math.round(ms / 1000)
}

// parseYAML reads the deploy/dbperf/targets.yaml layout: {targets: [...]} or a bare list.
export function parseYAML(text: string): Row[] {
  const doc = yaml.load(text) as unknown
  const list = Array.isArray(doc) ? doc : ((doc as { targets?: unknown[] })?.targets ?? null)
  if (!Array.isArray(list)) throw new Error('ожидается список targets')
  return list.map((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>
    const input: CreateTargetInput = {
      targetId: typeof r.id === 'number' ? r.id : undefined,
      name: String(r.name ?? ''),
      dsn: String(r.dsn ?? ''),
      intervalSec: parseDuration(r.interval ?? r.interval_sec, 'sec'),
      statementTimeoutMs: parseDuration(r.statement_timeout ?? r.statement_timeout_ms, 'ms'),
      enabled: typeof r.enabled === 'boolean' ? r.enabled : undefined,
      labels: typeof r.labels === 'object' && r.labels ? Object.fromEntries(Object.entries(r.labels as object).map(([k, v]) => [k, String(v)])) : undefined,
    }
    let error = validateInput(input)
    if (Number.isNaN(input.intervalSec) || Number.isNaN(input.statementTimeoutMs)) error = `строка ${i + 1}: неверная длительность`
    return { input, error }
  })
}

const CHUNK = 1000

// BulkImport loads a YAML file, previews it and creates targets in chunks.
export function BulkImport({ onClose, onDone }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [skipExisting, setSkipExisting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<{ created: number; skipped: number; failed: number } | null>(null)

  const onFile = async (f: File | undefined) => {
    if (!f) return
    setFileName(f.name)
    setSummary(null)
    try {
      setRows(parseYAML(await f.text()))
      setError(null)
    } catch (e) {
      setRows(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const submit = async () => {
    if (!rows) return
    const valid = rows.map((r, i) => ({ r, i })).filter(({ r }) => !r.error)
    setBusy(true)
    setError(null)
    const sum = { created: 0, skipped: 0, failed: 0 }
    try {
      const next = rows.map((r) => ({ ...r }))
      for (let off = 0; off < valid.length; off += CHUNK) {
        const chunk = valid.slice(off, off + CHUNK)
        const resp = await registry.bulkCreate(chunk.map(({ r }) => r.input), skipExisting)
        sum.created += resp.created
        sum.skipped += resp.skipped
        sum.failed += resp.failed
        for (const res of resp.results ?? []) next[chunk[res.index].i].result = res
      }
      setRows(next)
      setSummary(sum)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const invalid = rows?.filter((r) => r.error).length ?? 0
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>Импорт объектов из YAML</span>
          <button className="btn icon-btn" onClick={onClose} aria-label="Закрыть">×</button>
        </div>
        <div className="muted small">
          Формат файла: <code>targets:</code> со списком записей <code>name</code>, <code>dsn</code>, <code>interval</code> (например <code>10s</code>),{' '}
          <code>statement_timeout</code>, <code>enabled</code>, <code>labels</code>, необязательный <code>id</code> — как в <code>deploy/dbperf/targets.yaml</code>.
        </div>
        <div className="row">
          <input type="file" accept=".yaml,.yml,application/x-yaml,text/yaml" onChange={(e) => onFile(e.target.files?.[0])} />
          <label className="checkbox">
            <input type="checkbox" checked={skipExisting} onChange={(e) => setSkipExisting(e.target.checked)} />
            пропускать существующие имена
          </label>
        </div>
        {error && <div className="error">{error}</div>}
        {rows && (
          <>
            <div className="muted small">
              {fileName}: {rows.length} записей, {invalid > 0 ? `${invalid} с ошибками (не будут отправлены)` : 'ошибок нет'}
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th><th>Имя</th><th>Интервал</th><th>Вкл</th><th>Метки</th><th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className={r.error ? 'row-error' : r.result?.status === 'FAILED' ? 'row-error' : r.result?.status === 'CREATED' ? 'row-ok' : ''}>
                      <td>{i + 1}</td>
                      <td className="mono">{r.input.name || '—'}</td>
                      <td>{r.input.intervalSec ?? 10} с</td>
                      <td>{r.input.enabled === false ? 'нет' : 'да'}</td>
                      <td className="muted">{Object.entries(r.input.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')}</td>
                      <td>
                        {r.error ? <span className="err">{r.error}</span>
                          : r.result?.status === 'CREATED' ? `создан, id ${r.result.targetId}`
                          : r.result?.status === 'SKIPPED' ? `пропущен, есть id ${r.result.targetId}`
                          : r.result?.status === 'FAILED' ? <span className="err">{r.result.error}</span>
                          : 'готов к загрузке'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {summary && (
          <div className="muted">
            Итог: создано {summary.created}, пропущено {summary.skipped}, с ошибкой {summary.failed}
          </div>
        )}
        <div className="popover-actions">
          <button className="btn" onClick={onClose} disabled={busy}>{summary ? 'Закрыть' : 'Отмена'}</button>
          {!summary && (
            <button className="btn primary" onClick={submit} disabled={busy || !rows || rows.length - invalid === 0}>
              Загрузить {rows ? rows.length - invalid : ''}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
