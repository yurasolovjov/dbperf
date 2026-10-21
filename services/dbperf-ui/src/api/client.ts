import type {
  Dimension,
  Filter,
  ProfileResponse,
  QueryTextResponse,
  SessionsResponse,
  Target,
  TargetStatus,
  TimeRange,
  TimeSeriesResponse,
  TopResponse,
  TopSlicing,
  TotalsResponse,
} from './types'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

const base = import.meta.env.VITE_API_BASE ?? '/api/v1'

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = text
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text
    } catch {
      // keep raw text
    }
    throw new ApiError(res.status, msg || res.statusText)
  }
  return JSON.parse(text, reviveInt64) as T
}

// protojson encodes int64 as strings; turn numeric strings of known int64
// fields back into numbers so the UI can do arithmetic on them.
const int64Keys = new Set([
  'startUnix',
  'endUnix',
  'timestamps',
  'nSamples',
  'disconnectedSince',
  'lastSampleAt',
  'ts',
  'backendStart',
  'xactStart',
  'queryStart',
  'stateChange',
  'sampleTs',
  'lastSeen',
  'samples',
  'totalSamples',
])

function reviveInt64(this: unknown, key: string, value: unknown): unknown {
  if (int64Keys.has(key)) {
    if (typeof value === 'string') return Number(value)
    if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? Number(v) : v))
  }
  return value
}

export interface TimeSeriesParams {
  targetId: number
  range: TimeRange
  stepSeconds: number
  slicing: TopSlicing
  filters: Filter[]
  excludeSelf: boolean
  maxPoints?: number
}

export const api = {
  listTargets: (signal?: AbortSignal) =>
    post<{ targets: Target[] }>('/targets/list', { pageSize: 1000 }, signal).then((r) => r.targets ?? []),

  targetStatus: (targetId: number, signal?: AbortSignal) =>
    post<TargetStatus>('/targets/status', { targetId }, signal),

  timeSeries: (p: TimeSeriesParams, signal?: AbortSignal) =>
    post<TimeSeriesResponse>('/activity/timeseries', p, signal),

  top: (
    p: { targetId: number; range: TimeRange; slicing: TopSlicing; subSlicing?: TopSlicing; filters: Filter[]; excludeSelf: boolean },
    signal?: AbortSignal,
  ) => post<TopResponse>('/activity/top', p, signal),

  totals: (
    p: { targetId: number; range: TimeRange; stepSeconds: number; filters: Filter[]; excludeSelf: boolean },
    signal?: AbortSignal,
  ) => post<TotalsResponse>('/activity/totals', p, signal),

  sessions: (p: { targetId: number; atUnix: number; filters: Filter[]; limit: number }, signal?: AbortSignal) =>
    post<SessionsResponse>('/activity/sessions', p, signal),

  queryText: (targetId: number, queryHash: string, signal?: AbortSignal) =>
    post<QueryTextResponse>('/activity/query-text', { targetId, queryHash }, signal),

  profile: (
    p: { targetId: number; range: TimeRange; dimensions: Dimension[]; filters: Filter[]; excludeSelf: boolean; minSamples?: number },
    signal?: AbortSignal,
  ) => post<ProfileResponse>('/activity/profile', p, signal),
}

export const DIMENSIONS: { key: Dimension; label: string; column: string }[] = [
  { key: 'WAIT_EVENT_TYPE', label: 'Типы ожиданий', column: 'Тип ожидания' },
  { key: 'WAIT_EVENT', label: 'Ожидания', column: 'Событие ожидания' },
  { key: 'QUERY', label: 'SQL', column: 'Текст запроса' },
  { key: 'CLIENT_ADDR', label: 'Хосты', column: 'Адрес клиента' },
  { key: 'USENAME', label: 'Пользователи', column: 'Пользователь' },
  { key: 'DATNAME', label: 'Базы данных', column: 'База данных' },
  { key: 'APPLICATION_NAME', label: 'Приложения', column: 'Приложение' },
  { key: 'PID', label: 'Процессы', column: 'Процесс' },
]
