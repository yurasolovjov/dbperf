import { useState } from 'react'
import { registry, validateInput, type CreateTargetInput, type RegistryTarget } from '../api/registry'

interface Props {
  target: RegistryTarget | null // null = create
  onClose: () => void
  onSaved: (t: RegistryTarget) => void
}

function labelsToText(l?: Record<string, string>): string {
  return Object.entries(l ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

function textToLabels(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of s.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

// TargetForm creates or edits one monitoring object.
export function TargetForm({ target, onClose, onSaved }: Props) {
  const [name, setName] = useState(target?.name ?? '')
  const [dsn, setDsn] = useState(target?.dsn ?? 'postgres://dbperf:dbperf@host:5432/postgres?sslmode=disable')
  const [interval, setInterval_] = useState(target?.intervalSec ?? 10)
  const [timeout, setTimeout_] = useState(target?.statementTimeoutMs ?? 5000)
  const [enabled, setEnabled] = useState(target?.enabled ?? true)
  const [labels, setLabels] = useState(labelsToText(target?.labels))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const input: CreateTargetInput = { name, dsn, intervalSec: interval, statementTimeoutMs: timeout, enabled, labels: textToLabels(labels) }
    const err = validateInput(input)
    if (err) {
      setError(err)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const saved = target
        ? await registry.update({ ...target, ...input, labels: input.labels ?? {} }, ['name', 'dsn', 'interval_sec', 'statement_timeout_ms', 'enabled', 'labels'])
        : await registry.create(input)
      onSaved(saved)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg.includes('revision mismatch') ? 'Объект изменён кем-то другим: закройте форму, обновите список и повторите' : msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{target ? `Изменить ${target.name}` : 'Новый объект мониторинга'}</span>
          <button className="btn icon-btn" onClick={onClose} aria-label="Закрыть">×</button>
        </div>
        <label>
          Имя
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-shop-1" autoFocus />
        </label>
        <label>
          DSN
          <input value={dsn} onChange={(e) => setDsn(e.target.value)} spellCheck={false} />
        </label>
        <div className="row2">
          <label>
            Интервал снимка, с
            <input type="number" min={1} max={3600} value={interval} onChange={(e) => setInterval_(Number(e.target.value))} />
          </label>
          <label>
            statement_timeout, мс
            <input type="number" min={100} max={600000} step={100} value={timeout} onChange={(e) => setTimeout_(Number(e.target.value))} />
          </label>
        </div>
        <label>
          Метки, по одной на строку: ключ=значение
          <textarea rows={3} value={labels} onChange={(e) => setLabels(e.target.value)} placeholder={'env=prod\ncluster=shop'} />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Включён (выдаётся коллекторам в аренду)
        </label>
        {error && <div className="error">{error}</div>}
        <div className="popover-actions">
          <button className="btn" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="btn primary" onClick={submit} disabled={busy}>{target ? 'Сохранить' : 'Создать'}</button>
        </div>
      </div>
    </div>
  )
}
