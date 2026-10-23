// Client of dbperf-registry (TargetRegistry and LeaseService) through its JSON gateway.
import { postJSON } from './client'

export interface RegistryTarget {
  targetId: number
  name: string
  dsn: string
  intervalSec: number
  statementTimeoutMs: number
  enabled: boolean
  labels: Record<string, string>
  createdAt: number
  updatedAt: number
  revision: number
}

export interface CreateTargetInput {
  targetId?: number
  name: string
  dsn: string
  intervalSec?: number
  statementTimeoutMs?: number
  enabled?: boolean
  labels?: Record<string, string>
}

export interface BulkResult {
  index: number
  name: string
  targetId: number
  status: 'STATUS_UNSPECIFIED' | 'CREATED' | 'SKIPPED' | 'FAILED'
  error: string
}

export interface BulkResponse {
  created: number
  skipped: number
  failed: number
  results: BulkResult[]
}

export interface InstanceAssignments {
  instance: string
  capacity: number
  version: string
  registeredAt: number
  expiresAt: number
  targetIds: number[]
}

export interface AssignmentsResponse {
  instances: InstanceAssignments[]
  unassigned: number[]
}

const base = '/api/v1/registry'

export const registry = {
  async list(signal?: AbortSignal): Promise<RegistryTarget[]> {
    const out: RegistryTarget[] = []
    let pageToken = ''
    for (;;) {
      const r = await postJSON<{ targets: RegistryTarget[]; nextPageToken: string }>(base, '/targets/list', { pageSize: 1000, pageToken }, signal)
      out.push(...(r.targets ?? []))
      if (!r.nextPageToken) return out
      pageToken = r.nextPageToken
    }
  },
  get: (targetId: number, signal?: AbortSignal) => postJSON<RegistryTarget>(base, '/targets/get', { targetId }, signal),
  create: (t: CreateTargetInput, signal?: AbortSignal) => postJSON<RegistryTarget>(base, '/targets/create', t, signal),
  // protojson writes FieldMask paths in lowerCamelCase ("intervalSec"); the
  // server sees them as snake_case after decoding.
  update: (t: RegistryTarget, paths: string[], signal?: AbortSignal) =>
    postJSON<RegistryTarget>(base, '/targets/update', { target: t, updateMask: paths.map(toCamel).join(','), expectedRevision: String(t.revision) }, signal),
  delete: (targetId: number, signal?: AbortSignal) => postJSON<unknown>(base, '/targets/delete', { targetId }, signal),
  bulkCreate: (targets: CreateTargetInput[], skipExisting: boolean, signal?: AbortSignal) =>
    postJSON<BulkResponse>(base, '/targets/bulk-create', { targets, skipExisting }, signal),
  assignments: (signal?: AbortSignal) => postJSON<AssignmentsResponse>(base, '/assignments', {}, signal),
}

// ownerOf maps target id to the dbperf instance running it.
export function ownerOf(a: AssignmentsResponse | null): Map<number, string> {
  const m = new Map<number, string>()
  for (const inst of a?.instances ?? []) for (const id of inst.targetIds ?? []) m.set(id, inst.instance)
  return m
}

// redactDSN hides the password in a connection string.
export function redactDSN(dsn: string): string {
  const at = dsn.lastIndexOf('@')
  const scheme = dsn.indexOf('://')
  if (at < 0 || scheme < 0) return dsn
  const cred = dsn.slice(scheme + 3, at)
  const colon = cred.indexOf(':')
  return colon < 0 ? dsn : `${dsn.slice(0, scheme + 3)}${cred.slice(0, colon)}:***${dsn.slice(at)}`
}

export const NAME_RE = /^[A-Za-z0-9._-]{1,128}$/

export function validateInput(t: CreateTargetInput): string | null {
  if (!NAME_RE.test(t.name ?? '')) return 'имя: 1–128 символов из [A-Za-z0-9._-]'
  if (!/^postgres(ql)?:\/\/.+/.test(t.dsn ?? '')) return 'dsn: ожидается postgres://user:pass@host:port/db'
  if (t.intervalSec !== undefined && (t.intervalSec < 1 || t.intervalSec > 3600)) return 'интервал: 1–3600 с'
  if (t.statementTimeoutMs !== undefined && (t.statementTimeoutMs < 100 || t.statementTimeoutMs > 600000)) return 'statement_timeout: 100–600000 мс'
  return null
}

function toCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}
