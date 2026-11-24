import type { LogLine } from '@/gen'

/**
 * What a stream row shows (boards v0.1.1-03.x): REQUEST (method + path) or JOB
 * (job name / queue), then FLOW · RESULT: `flow → status · detail`.
 */
export interface RowParts {
  /** HTTP: method (muted) + path (bright). */
  method?: string
  path?: string
  /** Not HTTP: the job, queue or operation name. */
  name?: string
  /** The business flow (`flow`), else a legacy operation / event / message. */
  event: string
  /** After the arrow: status_code, else an error reason / code or outcome. */
  outcome?: string
  tone: 'ok' | 'warn' | 'err' | 'muted'
  /**
   * After the outcome, in order: the error's reason when the status is shown
   * (`invalid_signature`), a created resource (`order 1181`), `slow`,
   * `attempt 2`, `final`.
   */
  extra: string[]
  /** Tone of the first extra (an error reason reads red, `slow` amber). */
  extraTone?: RowParts['tone']
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
const PATH = [
  'path',
  'url.path',
  'request.route',
  'route',
  'http.route',
  'http.target',
  'req.url',
  'url',
  'request.path',
]
const STATUS = [
  'status_code',
  'status',
  'statusCode',
  'http.response.status_code',
  'http.status_code',
  'res.statusCode',
]
const JOB = ['job_name', 'job', 'jobName', 'queue', 'worker', 'task']
/** `flow` is the v0.1.1 business name; the rest are v0.1.0 / other loggers. */
const EVENT = ['flow', 'wideEvents.flow', 'operation', 'event', 'phase', 'step', 'handler', 'action', 'name']
const OUTCOME = ['outcome', 'result', 'state']
const REASON = ['error.reason', 'err.reason', 'error.code', 'err.code', 'err.name', 'error.name']
const FAILED = ['failed', 'error', 'errored', 'fail']
const WARNED = ['retry', 'retrying', 'timeout', 'partial', 'needs_review', 'slow']
/** Top-level fields that are never a business resource. */
const NOT_BUSINESS = new Set(['request', 'response', 'error', 'err', 'wideEvents', 'retry', 'user'])
const SLOW_MS = 1000

/** A created resource on a 201: the first business object with an id (`order 1181`). */
function created(f: Fields): string | undefined {
  for (const [k, v] of Object.entries(f)) {
    if (NOT_BUSINESS.has(k) || !v || typeof v !== 'object' || Array.isArray(v)) continue
    const id = (v as Fields).id
    if (typeof id === 'string' || typeof id === 'number') {
      const short = String(id).replace(/^[a-z]+_/, '')
      return `${k} ${short}`
    }
  }
  return undefined
}

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
  if (event === name) event = text(f, ['flow', 'phase', 'step', 'operation', 'event'])?.[1] ?? l.msg

  const status = text(f, STATUS)
  const outcome = text(f, OUTCOME)
  const reason = text(f, REASON)
  const n = status ? Number(status[1]) : Number.NaN
  const o = outcome?.[1].toLowerCase()

  let out: [string, string] | undefined
  if (status) out = status
  else if (reason && bad) out = reason
  else if (outcome) out = outcome
  else if (reason) out = reason
  else if (arrow.length > 1) out = ['', arrow.slice(1).join(' → ')]
  // A job attempt that finished without an error: its completion event.
  else if (!http && typeof f.duration_ms === 'number' && !bad) out = ['', 'ok']

  // v0.1.1: a recorded error or HTTP >= 400 is an error, so a 4xx reads red.
  // A slow success keeps its green status; the `slow` tag carries the warning.
  let tone: RowParts['tone'] = 'ok'
  if (bad || n >= 400 || (o && FAILED.includes(o))) tone = 'err'
  else if ((o && WARNED.includes(o)) || (warned && !status)) tone = 'warn'
  else if (!out) tone = 'muted'

  const extra: string[] = []
  let extraTone: RowParts['tone'] | undefined
  // The status is shown, so the reason follows it: `401 · invalid_signature`.
  if (status && reason && (bad || n >= 400)) {
    extra.push(reason[1])
    extraTone = 'err'
  }
  if (status && n === 201 && !bad) {
    const c = created(f)
    if (c) extra.push(c)
  }
  const dur = typeof f.duration_ms === 'number' ? f.duration_ms : undefined
  // A success logged at warn is a slow success: `200 · slow`.
  const slowSuccess = status ? n < 400 : !outcome && !reason && dur != null && dur >= SLOW_MS
  if (!bad && warned && slowSuccess && out?.[1] !== 'slow') {
    extra.push('slow')
    extraTone ??= 'warn'
  }
  const attempt = at(f, 'attempt') ?? at(f, 'attemptsMade')
  if (typeof attempt === 'number' && !http) extra.push(`attempt ${attempt}`)
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
    extraTone,
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

/** Fields shown in the inline preview (03.5): the useful ones first, at most 12. */
const PREVIEW_FIRST = [
  'request_id',
  'status_code',
  'status',
  'duration_ms',
  'flow',
  'method',
  'path',
  'error.reason',
  'error.code',
  'err.code',
  'job_id',
  'queue',
  'attempt',
  'request.headers',
  'response.headers',
  'request.body_capture',
  'response.body_capture',
  'user_id',
  'outcome',
  'sample_reason',
]
const PREVIEW_SKIP = new Set(['msg', 'message', 'time', 'timestamp', 'ts', '@timestamp', 'level', 'v', 'pid'])

export const REDACTED = '[REDACTED]'

/** Values that were removed before the log was written, anywhere inside `v`. */
export function redactedCount(v: unknown, depth = 0): number {
  if (v === REDACTED) return 1
  if (depth > 6 || !v || typeof v !== 'object') return 0
  let n = 0
  for (const x of Array.isArray(v) ? v : Object.values(v)) n += redactedCount(x, depth + 1)
  return n
}

/** N from the pipeline's `redacted:N` flag (`server/src/redact.rs`), else 0. */
export function redactedFlag(flags: readonly string[] | null | undefined): number {
  const f = flags?.find((x) => x.startsWith('redacted:'))
  return f ? Number(f.slice('redacted:'.length)) || 0 : 0
}

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
  // Nested objects last, as one entry (`order [1]`); request/response were
  // shown by their parts above.
  for (const [k, v] of Object.entries(f))
    if (v && typeof v === 'object' && k !== 'request' && k !== 'response') push(k, v)
  return out
}
