import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { fmtDateTime } from '../lib/format'
interface Props {
  targetId: number
  hash: string | null
  onClose: () => void
  onFilter?: (hash: string) => void
}
export function QueryModal({ targetId, hash, onClose, onFilter }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState(''),
    [meta, setMeta] = useState(''),
    [error, setError] = useState<string | null>(null),
    [feedback, setFeedback] = useState(''),
    [tick, setTick] = useState(0)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!hash) {
      ref.current?.close()
      return
    }
    ref.current?.showModal()
    setText('')
    setMeta('')
    setError(null)
    setFeedback('')
    setLoading(true)
    const c = new AbortController()
    api
      .queryText(targetId, hash, c.signal)
      .then((r) => {
        if (c.signal.aborted) return
        setText(r.query)
        setMeta(
          `Последний раз: ${fmtDateTime(r.lastSeen)}${r.truncated ? ' · текст обрезан коллектором' : ''}`,
        )
      })
      .catch((e: unknown) => {
        if (!c.signal.aborted)
          setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false)
      })
    return () => c.abort()
  }, [targetId, hash, tick])
  const copy = async () => {
    try {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        const field = document.createElement('textarea')
        field.value = text
        field.style.position = 'fixed'
        field.style.opacity = '0'
        ref.current!.append(field)
        let copied = false
        try {
          field.select()
          copied = document.execCommand('copy')
        } finally {
          field.remove()
        }
        if (!copied)
          throw new Error('Не удалось скопировать. Выделите текст вручную.')
      }
      setFeedback('Запрос скопирован')
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : 'Не удалось скопировать')
    }
  }
  return (
    <dialog
      className="modal sql-dialog"
      ref={ref}
      aria-labelledby="query-title"
      onCancel={onClose}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) {
          const r = ref.current.getBoundingClientRect()
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose()
        }
      }}
    >
      <div className="modal-head">
        <span id="query-title">SQL · #{hash}</span>
        <button
          type="button"
          className="btn icon-btn"
          aria-label="Закрыть запрос"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {error ? (
        <div className="error" role="alert">
          {error}{' '}
          <button
            type="button"
            className="link"
            onClick={() => setTick((v) => v + 1)}
          >
            Повторить
          </button>
        </div>
      ) : (
        <pre className="sql" tabIndex={0}>
          {loading ? 'Загружаем текст запроса…' : text || 'Текст запроса пуст'}
        </pre>
      )}
      <div className="muted">{meta}</div>
      <div className="sql-dialog-footer">
        <span role="status">{feedback}</span>
        <div className="row">
          <button
            type="button"
            className="btn"
            disabled={loading || !!error || !text}
            onClick={copy}
          >
            Скопировать
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!hash}
            onClick={() => {
              if (hash) {
                onFilter?.(hash)
                onClose()
              }
            }}
          >
            Добавить в фильтры
          </button>
        </div>
      </div>
    </dialog>
  )
}
