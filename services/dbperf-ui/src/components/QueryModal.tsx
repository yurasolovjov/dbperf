import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { fmtDateTime } from '../lib/format'

interface Props {
  targetId: number
  hash: string | null
  onClose: () => void
}

export function QueryModal({ targetId, hash, onClose }: Props) {
  const [text, setText] = useState<string>('')
  const [meta, setMeta] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!hash) return
    setText('')
    setError(null)
    const c = new AbortController()
    api
      .queryText(targetId, hash, c.signal)
      .then((r) => {
        setText(r.query)
        setMeta(`последний раз: ${fmtDateTime(r.lastSeen)}${r.truncated ? ' · текст обрезан' : ''}`)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    return () => c.abort()
  }, [targetId, hash])

  if (!hash) return null
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>Запрос #{hash}</span>
          <button className="btn icon-btn" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </div>
        {error ? <div className="error">{error}</div> : <pre className="sql">{text || '…'}</pre>}
        <div className="muted">{meta}</div>
      </div>
    </div>
  )
}
