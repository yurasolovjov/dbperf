import { DesignedSelect } from './activity/designed-select'
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
        <DesignedSelect
          label="Объект мониторинга"
          value={String(targetId)}
          options={targets.map((t) => ({
            value: String(t.targetId),
            label: t.name,
          }))}
          onChange={(v) => onChange(Number(v))}
        />
        <span className="crumb-sep">/</span>
        <span className="crumb-current">Активность сессии</span>
      </div>
      {target && status && (
        <div
          className={`status status-${status.state.toLowerCase()}`}
          title={status.lastError || ''}
        >
          <span className="dot" />
          {status.state === 'STATE_UNSPECIFIED' && status.ownerInstance
            ? `ведёт ${status.ownerInstance}`
            : stateLabel[status.state]}
          {status.lastSampleAt > 0 && (
            <span className="status-detail">
              · снимок {fmtDateTime(status.lastSampleAt)}
            </span>
          )}
          {status.serverVersionNum > 0 && (
            <span className="status-detail">
              · PostgreSQL {Math.floor(status.serverVersionNum / 10000)}
            </span>
          )}
          <span className="status-detail">· тик {target.intervalSec} с</span>
        </div>
      )}
    </header>
  )
}
