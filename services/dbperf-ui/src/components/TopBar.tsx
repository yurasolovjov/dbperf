import { DesignedSelect } from './activity/designed-select'
import type { Target, TargetStatus } from '../api/types'

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
        <span
          className="focus-badge"
          title={status.lastError || `${stateLabel[status.state]} · ${status.ownerInstance || 'сборщик не назначен'} · тик ${target.intervalSec} с`}
        >
          PostgreSQL{status.serverVersionNum > 0 ? ` ${Math.floor(status.serverVersionNum / 10000)}` : ''}
        </span>
      )}
    </header>
  )
}
