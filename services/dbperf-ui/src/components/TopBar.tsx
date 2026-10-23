import type { Target, TargetStatus } from '../api/types'
import { fmtDateTime } from '../lib/format'

interface Props {
  targets: Target[]
  targetId: number
  status: TargetStatus | null
  onChange: (id: number) => void
}

const stateLabel: Record<TargetStatus['state'], string> = {
  CONNECTED: 'подключена',
  DISCONNECTED: 'нет соединения',
  DISABLED: 'отключена',
  STATE_UNSPECIFIED: 'нет данных',
}

export function TopBar({ targets, targetId, status, onChange }: Props) {
  const target = targets.find((t) => t.targetId === targetId)
  return (
    <header className="topbar">
      <div className="crumbs">
        <select className="target-select" value={targetId} onChange={(e) => onChange(Number(e.target.value))}>
          {targets.map((t) => (
            <option key={t.targetId} value={t.targetId}>
              {t.name}
            </option>
          ))}
        </select>
        <span className="crumb-sep">/</span>
        <span className="crumb-muted">Активность сессии</span>
        <span className="crumb-sep">/</span>
        <span className="crumb-current">Активность сессии</span>
      </div>
      {target && status && (
        <div className={`status status-${status.state.toLowerCase()}`} title={status.lastError || ''}>
          <span className="dot" />
          {status.state === 'STATE_UNSPECIFIED' && status.ownerInstance ? `ведёт ${status.ownerInstance}` : stateLabel[status.state]}
          {status.lastSampleAt > 0 && <span className="status-detail">· снимок {fmtDateTime(status.lastSampleAt)}</span>}
          {status.serverVersionNum > 0 && (
            <span className="status-detail">· PostgreSQL {Math.floor(status.serverVersionNum / 10000)}</span>
          )}
          <span className="status-detail">· тик {target.intervalSec} с</span>
        </div>
      )}
    </header>
  )
}
