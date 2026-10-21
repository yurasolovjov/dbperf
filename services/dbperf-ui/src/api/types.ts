// JSON shapes of the dbperf API: the protojson mapping of api/proto/dbperf/v1.
// int64 fields arrive as strings; the client converts them to numbers.

export type Dimension =
  | 'WAIT_EVENT_TYPE'
  | 'WAIT_EVENT'
  | 'QUERY'
  | 'CLIENT_ADDR'
  | 'USENAME'
  | 'DATNAME'
  | 'PID'
  | 'APPLICATION_NAME'
  | 'BACKEND_TYPE'

export interface TimeRange {
  startUnix: number
  endUnix: number
}

export interface Filter {
  dimension: Dimension
  values: string[]
  exclude?: boolean
}

export interface TopSlicing {
  dimension: Dimension
  limit: number
}

export interface SliceValue {
  value: string
  shortText: string
  isRemainder: boolean
  id: number
}

export interface Target {
  targetId: number
  name: string
  intervalSec: number
  enabled: boolean
}

export interface TargetStatus {
  targetId: number
  ownerInstance: string
  state: 'STATE_UNSPECIFIED' | 'CONNECTED' | 'DISCONNECTED' | 'DISABLED'
  disconnectedSince: number
  lastSampleAt: number
  lastError: string
  serverVersionNum: number
  lastSampleDurationMs: number
}

export interface Series {
  slice: SliceValue
  values: number[]
  average: number
}

export interface TimeSeriesResponse {
  range: TimeRange
  stepSeconds: number
  level: string
  timestamps: number[]
  totals: number[]
  series: Series[]
}

export interface TopEntry {
  slice: SliceValue
  aas: number
  percent: number
  sub: TopEntry[]
}

export interface TopResponse {
  totalAas: number
  nSamples: number
  entries: TopEntry[]
}

export interface TotalsResponse {
  stepSeconds: number
  timestamps: number[]
  values: number[]
  average: number
}

export interface Session {
  ts: number
  pid: number
  leaderPid: number
  backendType: string
  datname: string
  usename: string
  applicationName: string
  clientAddr: string
  state: string
  waitEventType: string
  waitEvent: string
  backendStart: number
  xactStart: number
  queryStart: number
  stateChange: number
  queryHash: string
  queryShort: string
}

export interface SessionsResponse {
  sampleTs: number
  sessions: Session[]
}

export interface QueryTextResponse {
  query: string
  lastSeen: number
  truncated: boolean
}
