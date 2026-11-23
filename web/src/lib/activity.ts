import type { CorrId, LogLine } from '@/gen'
import { rowParts } from '@/lib/row'

/**
 * Flow → activity list (boards v0.1.1-04.1 … 04.5): one row per request or
 * logical job, attempts grouped inside their job. Built only from the events
 * in the flow: a shared id is correlation, not parentage, so child jobs need
 * an explicit parent link, and a job's state comes from its own events
 * ("Completion not observed" when they don't settle it).
 */

type Fields = Record<string, unknown>

export type Tone = 'ok' | 'warn' | 'err' | 'muted'

export interface RequestRow {
  kind: 'request'
  line: LogLine
  method: string
  path: string
  flow?: string
  status?: number
  /** `201 · Created`, `500 · renderer_timeout`. */
  label: string
  tone: Tone
  duration?: number
}

export type JobState = 'completed' | 'completed_after_retry' | 'failed' | 'retry_scheduled' | 'not_observed'

export interface Attempt {
  line: LogLine
  /** The queue's own attempt number, when it logged one. */
  n: number | null
  /** `Attempt 2`, or the lifecycle event name for a line without one. */
  title: string
  /** The error's reason or code, or the step that finished. */
  detail?: string
  tone: Tone
  final: boolean
  duration?: number
}

export interface JobRow {
  kind: 'job'
  key: string
  jobId: string
  queue?: string
  source: string
  flow: string
  attempts: Attempt[]
  state: JobState
  /** `Completed after retry`, `Failed · 3 attempts`, `Completion not observed`. */
  label: string
  tone: Tone
  /** Execution time of the last finished attempt. */
  exec?: number
  /** Its attempt number (`#2`). */
  lastN?: number | null
  parent?: string
  children: JobRow[]
}

export interface OtherRow {
  kind: 'other'
  line: LogLine
  title: string
  tone: Tone
}

export interface Activity {
  /** Requests and top-level jobs in display order, then what's related to them. */
  main: (RequestRow | JobRow)[]
  /** Requests related to a job that was opened by its id (04.2). */
  related: RequestRow[]
  other: OtherRow[]
  requests: number
  jobs: number
  /** Completion events: request summaries and finished attempts. */
  completions: number
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No content',
  301: 'Moved',
  302: 'Found',
  304: 'Not modified',
  400: 'Bad request',
  401: 'Unauthorized',
  402: 'Payment required',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  422: 'Unprocessable',
  429: 'Too many requests',
  500: 'Server error',
  502: 'Bad gateway',
  503: 'Unavailable',
  504: 'Gateway timeout',
}

function at(f: Fields, path: string): unknown {
  if (path in f) return f[path]
  let cur: unknown = f
  for (const p of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Fields)[p]
  }
  return cur
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined)
const num = (v: unknown) => (typeof v === 'number' ? v : undefined)

function jobIdOf(l: LogLine): string | undefined {
  const f = (l.fields ?? {}) as Fields
  return str(f.job_id) ?? str(f.jobId) ?? l.ids.find((i) => i.key === 'job_id')?.value
}

function failed(l: LogLine, f: Fields) {
  const o = str(f.outcome)?.toLowerCase()
  return l.level === 'error' || l.level === 'fatal' || o === 'failed' || f.error != null || f.err != null
}

function isFinal(f: Fields, l: LogLine) {
  const step = `${str(f.phase) ?? ''} ${l.msg}`
  return f.final === true || f.retries_left === 0 || /moved_to_failed|moved to failed/.test(step)
}

function retryScheduled(f: Fields) {
  return f.retry != null || f.backoff_ms != null || f.next_retry_in_ms != null || str(f.outcome) === 'retry'
}

function requestRow(l: LogLine): RequestRow | null {
  const p = rowParts(l)
  if (!p.method || !p.path) return null
  const f = (l.fields ?? {}) as Fields
  const status = Number(p.outcomeKey && /status/i.test(p.outcomeKey) ? p.outcome : Number.NaN)
  const has = Number.isFinite(status)
  const bad = l.level === 'error' || l.level === 'fatal' || (has && status >= 400)
  const reason = str(at(f, 'error.reason')) ?? str(at(f, 'error.code')) ?? str(at(f, 'err.code'))
  const text = has ? (bad && reason ? reason : (STATUS_TEXT[status] ?? (bad ? 'error' : 'ok'))) : 'no status'
  return {
    kind: 'request',
    line: l,
    method: p.method,
    path: p.path,
    flow: str(f.flow) ?? (p.event !== l.msg ? p.event : undefined),
    status: has ? status : undefined,
    label: has ? `${status} · ${text}` : text,
    tone: bad ? 'err' : l.level === 'warn' ? 'warn' : has ? 'ok' : 'muted',
    duration: num(f.duration_ms),
  }
}

function attemptOf(l: LogLine, i: number): Attempt {
  const f = (l.fields ?? {}) as Fields
  const n = num(f.attempt) ?? num(f.retry_attempt) ?? num(f.attemptsMade) ?? null
  const bad = failed(l, f)
  const reason = str(at(f, 'error.reason')) ?? str(at(f, 'error.code')) ?? str(at(f, 'err.code'))
  const step = str(f.phase) ?? str(f.step)
  const duration = num(f.duration_ms)
  const lifecycle = n == null && duration == null
  return {
    line: l,
    n,
    title: n != null ? `Attempt ${n}` : lifecycle ? (step ?? (l.msg || 'event')) : `Attempt ${i + 1}`,
    detail: bad ? reason : (str(f.outcome) ?? step),
    tone: bad ? 'err' : l.level === 'warn' ? 'warn' : lifecycle ? 'muted' : 'ok',
    final: isFinal(f, l),
    duration,
  }
}

function jobState(attempts: Attempt[]): Pick<JobRow, 'state' | 'label' | 'tone' | 'exec' | 'lastN'> {
  const runs = attempts.filter((a) => a.duration != null || a.n != null)
  const finished = runs.filter((a) => a.duration != null)
  const lastRun = runs[runs.length - 1]
  const exec = finished[finished.length - 1]?.duration
  const lastN = lastRun?.n
  const count = runs.length || attempts.length
  const plural = `${count} ${count === 1 ? 'attempt' : 'attempts'}`
  const fails = runs.filter((a) => a.tone === 'err').length
  if (lastRun && lastRun.tone !== 'err' && lastRun.duration != null) {
    return fails > 0
      ? { state: 'completed_after_retry', label: 'Completed after retry', tone: 'ok', exec, lastN }
      : { state: 'completed', label: 'Completed', tone: 'ok', exec, lastN }
  }
  if (attempts.some((a) => a.final)) return { state: 'failed', label: `Failed · ${plural}`, tone: 'err', exec, lastN }
  if (lastRun?.tone === 'err' && retryScheduled((lastRun.line.fields ?? {}) as Fields))
    return { state: 'retry_scheduled', label: 'Retry scheduled', tone: 'warn', exec, lastN }
  return { state: 'not_observed', label: 'Completion not observed', tone: 'muted', exec, lastN }
}

/** Build the activity list for a flow's lines (oldest first). */
export function buildActivity(lines: LogLine[], opened: CorrId | null): Activity {
  const requests: RequestRow[] = []
  const byJob = new Map<string, LogLine[]>()
  const other: OtherRow[] = []
  for (const l of lines) {
    const job = jobIdOf(l)
    if (job) {
      const f = (l.fields ?? {}) as Fields
      const key = `${l.source}|${str(f.queue) ?? str(at(f, 'queue.name')) ?? ''}|${job}`
      byJob.set(key, [...(byJob.get(key) ?? []), l])
      continue
    }
    const r = requestRow(l)
    if (r) requests.push(r)
    else {
      const p = rowParts(l)
      other.push({ kind: 'other', line: l, title: p.event, tone: p.tone })
    }
  }

  const jobs: JobRow[] = []
  for (const [key, ls] of byJob) {
    const sorted = [...ls].sort((a, b) => a.ts - b.ts || a.id - b.id)
    const attempts = sorted.map(attemptOf)
    const f = (sorted[0].fields ?? {}) as Fields
    const [source, queue, jobId] = key.split('|')
    const flow =
      str(f.flow) ?? str(f.operation) ?? str(f.job_name) ?? rowParts(sorted[sorted.length - 1]).event ?? jobId
    const parent = str(f.parent_job_id) ?? str(at(f, 'parent.job_id'))
    jobs.push({
      kind: 'job',
      key,
      jobId,
      queue: queue || undefined,
      source,
      flow,
      attempts,
      ...jobState(attempts),
      parent,
      children: [],
    })
  }
  // Child jobs only with an explicit parent link from the queue.
  const byId = new Map(jobs.map((j) => [j.jobId, j]))
  const top: JobRow[] = []
  for (const j of jobs) {
    const p = j.parent ? byId.get(j.parent) : undefined
    if (p && p !== j) p.children.push(j)
    else top.push(j)
  }

  const openedJob = opened?.key === 'job_id'
  const main: (RequestRow | JobRow)[] = openedJob ? [...top] : [...requests, ...top]
  const completions =
    requests.filter((r) => r.status != null || r.duration != null).length +
    jobs.reduce((n, j) => n + j.attempts.filter((a) => a.duration != null).length, 0)
  return {
    main,
    related: openedJob ? requests : [],
    other,
    requests: requests.length,
    jobs: jobs.length,
    completions,
  }
}

/**
 * `1 request · 1 job`. Opened by a job id (04.2) the related request isn't
 * counted: `1 job · 3 attempts`; pass `related: true` to count it anyway.
 */
export function activityCounts(a: Activity, { related = false }: { related?: boolean } = {}): string {
  const parts: string[] = []
  const requests = related ? a.requests : a.requests - a.related.length
  if (requests > 0) parts.push(`${requests} ${requests === 1 ? 'request' : 'requests'}`)
  if (a.jobs) parts.push(`${a.jobs} ${a.jobs === 1 ? 'job' : 'jobs'}`)
  if (!requests && a.jobs === 1) {
    const j = a.main.find((r): r is JobRow => r.kind === 'job')
    if (j) parts.push(`${j.attempts.length} ${j.attempts.length === 1 ? 'attempt' : 'attempts'}`)
  }
  if (a.other.length) parts.push(`${a.other.length} ${a.other.length === 1 ? 'event' : 'events'}`)
  return parts.join(' · ')
}

/** The flow header's badge for a job opened by its id: `failed after 2 retries`. */
export function jobBadge(j: JobRow): string {
  const runs = j.attempts.filter((a) => a.n != null || a.duration != null).length || j.attempts.length
  const retries = Math.max(0, runs - 1)
  const after = `${retries} ${retries === 1 ? 'retry' : 'retries'}`
  switch (j.state) {
    case 'failed':
      return retries ? `failed after ${after}` : 'failed'
    case 'completed_after_retry':
      return `completed after ${after}`
    case 'completed':
      return 'completed'
    case 'retry_scheduled':
      return 'retry scheduled'
    default:
      return 'completion not observed'
  }
}

/** What the queue's own events established, for the 04.2 subtitle. */
export const JOB_EVIDENCE: Record<JobState, string> = {
  failed: 'terminal failure confirmed by the queue',
  completed_after_retry: 'completion confirmed after retry',
  completed: 'completion confirmed',
  retry_scheduled: 'retry scheduled by the queue',
  not_observed: 'completion not observed',
}

/** Backoffs the queue recorded between attempts, as `2s, then 4s`. */
export function retryDelays(j: JobRow): string | null {
  const ms = j.attempts
    .map((a) => {
      const f = (a.line.fields ?? {}) as Fields
      return num(at(f, 'retry.backoff_ms')) ?? num(f.backoff_ms) ?? num(f.next_retry_in_ms)
    })
    .filter((x): x is number => x != null)
  if (!ms.length) return null
  return ms.map((x) => (x >= 1000 ? `${Math.round(x / 100) / 10}s` : `${x}ms`)).join(', then ')
}
