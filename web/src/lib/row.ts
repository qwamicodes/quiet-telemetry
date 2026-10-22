import type { LogLine } from '@/gen'

/** What a stream row shows in its FLOW and SUMMARY columns. */
export interface RowParts {
  /** HTTP: method (muted) + path (bright). */
  method?: string
  path?: string
  /** Not HTTP: the job, queue or operation name. */
  name?: string
  /** The step: operation / event / phase / handler, else the message. */
  event: string
  /** After the arrow: status, outcome or error code. */
  outcome?: string
  tone: 'ok' | 'warn' | 'err' | 'muted'
  /** Extra bits after the outcome: `attempt 1`, `final`. */
  extra: string[]
  /** The field the outcome came from, so clicking it can filter. */
  outcomeKey?: string
}

type Fields = Record<string, unknown>

function at(f: Fields, path: string): unknown {
  if (path in f) return f[path]
  let cur: unknown = f
  for (const p of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Fields)[p]
  }
  return cur
}

function text(f: Fields, keys: string[]): [string, string] | undefined {
  for (const k of keys) {
    const v = at(f, k)
    if (typeof v === 'string' && v) return [k, v]
    if (typeof v === 'number') return [k, String(v)]
  }
  return undefined
}

const METHOD = ['method', 'http.request.method', 'http.method', 'req.method', 'request.method']
const PATH = ['path', 'route', 'url.path', 'http.route', 'http.target', 'req.url', 'url', 'request.path']
const STATUS = [
  'status',
  'status_code',
  'statusCode',
  'http.response.status_code',
  'http.status_code',
  'res.statusCode',
]
const JOB = ['job_name', 'job', 'queue', 'jobName', 'worker', 'task']
const EVENT = ['operation', 'event', 'phase', 'step', 'handler', 'action', 'wideEvents.flow', 'flow', 'name']
const OUTCOME = ['outcome', 'result', 'state']
const ERR = ['err.code', 'error.code', 'err.name', 'error.name']
const FAILED = ['failed', 'error', 'errored', 'fail']
const WARNED = ['retry', 'retrying', 'timeout', 'partial', 'needs_review', 'slow']

/** Split a line into the row's columns. Pure, so it is unit tested. */
export function rowParts(l: LogLine): RowParts {
  const f = (l.fields ?? null) as Fields | null
  const bad = l.level === 'error' || l.level === 'fatal'
  const warned = l.level === 'warn'
  if (!f) return { event: l.msg, tone: 'muted', extra: [] }

  const method = text(f, METHOD)?.[1]
  const path = text(f, PATH)?.[1]
  const http = Boolean(method && path)
  const name = http ? undefined : text(f, JOB)?.[1]
  let event = text(f, EVENT)?.[1]
  // pino-style "create_order → 201" messages already carry the event.
  const arrow = l.msg.split(' → ')
  if (!event) event = arrow.length > 1 ? arrow[0] : l.msg
  if (event === name) event = text(f, ['phase', 'step', 'operation', 'event'])?.[1] ?? l.msg

  const status = text(f, STATUS)
  const outcome = text(f, OUTCOME)
  const err = text(f, ERR)
  let out: [string, string] | undefined
  if (status) out = status
  else if (err && bad) out = err
  else if (outcome) out = outcome
  else if (err) out = err
  else if (arrow.length > 1) out = ['', arrow.slice(1).join(' → ')]

  const n = status ? Number(status[1]) : Number.NaN
  const o = outcome?.[1].toLowerCase()
  let tone: RowParts['tone'] = 'ok'
  if (bad || n >= 500 || (o && FAILED.includes(o))) tone = 'err'
  else if (warned || (n >= 400 && n < 500) || (o && WARNED.includes(o))) tone = 'warn'
  else if (!out) tone = 'muted'
  // A slow request logged at warn reads "→ slow" when nothing else says why.
  if (warned && status && n < 400) out = ['', 'slow']

  const extra: string[] = []
  const attempt = at(f, 'attempt') ?? at(f, 'attemptsMade')
  if (typeof attempt === 'number' && (attempt > 0 || tone !== 'ok')) extra.push(`attempt ${attempt}`)
  if (at(f, 'final') === true || at(f, 'retries_left') === 0) extra.push('final')
  return {
    method: http ? method : undefined,
    path: http ? path : undefined,
    name,
    event,
    outcome: out?.[1],
    outcomeKey: out?.[0] || undefined,
    tone,
    extra,
  }
}

/** The line's own duration (canonical lines carry `duration_ms`). */
export function lineDuration(l: LogLine): number | null {
  const f = l.fields
  if (!f) return null
  for (const k of ['duration_ms', 'durationMs', 'elapsed_ms', 'took_ms', 'responseTime']) {
    const v = f[k]
    if (typeof v === 'number') return v
  }
  return null
}

/** A `key:value` chip for the search language (quotes when needed). */
export function chip(key: string, value: unknown): string {
  const v = typeof value === 'string' ? value : JSON.stringify(value)
  return `${key}:${/[\s"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v}`
}

/** Fields shown in the inline preview: the useful ones first, at most 12. */
const PREVIEW_FIRST = [
  'request_id',
  'status',
  'duration_ms',
  'user_id',
  'method',
  'path',
  'err.code',
  'error.code',
  'job_id',
  'queue',
  'attempt',
  'outcome',
  'hostname',
  'should_sample',
  'sample_reason',
]
const PREVIEW_SKIP = new Set(['msg', 'message', 'time', 'timestamp', 'ts', '@timestamp', 'level', 'v', 'pid'])

export function previewFields(l: LogLine, max = 12): [string, unknown][] {
  const f = (l.fields ?? {}) as Fields
  const out: [string, unknown][] = []
  const seen = new Set<string>()
  const push = (k: string, v: unknown) => {
    if (out.length >= max || seen.has(k) || v === undefined) return
    seen.add(k)
    out.push([k, v])
  }
  for (const k of PREVIEW_FIRST) push(k, at(f, k))
  for (const [k, v] of Object.entries(f)) {
    if (PREVIEW_SKIP.has(k) || (v && typeof v === 'object' && !Array.isArray(v) && k !== 'wideEvents')) continue
    push(k, v)
  }
  // Nested objects last, as one entry (`wideEvents [5]`).
  for (const [k, v] of Object.entries(f)) if (v && typeof v === 'object') push(k, v)
  return out
}
