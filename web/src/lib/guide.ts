import { useEffect, useState } from 'react'
import promptDoc from '@/guide/agent-logging-prompt.md?raw'
import { toast } from '@/lib/toast'

/**
 * Guide (boards v0.1-11.x): the agent prompt and the stack notes added to it.
 * `src/guide/agent-logging-prompt.md` is a copy of `docs/agent-logging-prompt.md`
 * (a test keeps the two identical); the prompt is everything below its `---`.
 */
export const PROMPT_FILE = 'agent-logging-prompt.md'

export type StackId = 'node' | 'bun' | 'python' | 'go' | 'other'

export type Stack = {
  id: StackId
  /** One letter for the tile. */
  letter: string
  label: string
  sub: string
  /** What the notes add, under the picker. */
  adds: string
  notes: string[]
}

export const STACKS: Stack[] = [
  {
    id: 'node',
    letter: 'N',
    label: 'Node · pino',
    sub: 'Express, Fastify, Nest, Hono · BullMQ',
    adds: 'Node · pino adds 5 lines: one pino instance, an AsyncLocalStorage request context, a finish-hook middleware, BullMQ job ids, and middleware tests.',
    notes: [
      '- pino is built once (e.g. src/logger.ts) with `base: { service, env, version, commit_sha }` and `timestamp: pino.stdTimeFunctions.epochTime`; keep its epoch-ms `time` and add no second timestamp.',
      '- One middleware creates the request context in AsyncLocalStorage: `request_id` (incoming `x-request-id` or a new `req_` id), a start time, and a per-request `log` with `set()` / `call()`; it writes the single canonical line on `res.on("finish")` / `"close"` (Express), `onResponse` (Fastify) or after `await next()` in a try/finally (Hono, Koa), and sets the `x-request-id` response header.',
      '- Handlers call `log.set({ ... })` / `log.call({ ... })` and pass plain values to services; never pass `req` or the whole context.',
      '- BullMQ: put `request_id` in job data; the worker binds `logger.child({ job_id, request_id })`. BullMQ rejects custom jobIds that contain `:`, so use `-` there (`payout-88-1300`) and log `job_id` as `payout:88:1300`.',
      '- Tests: supertest (or `app.inject`) through the full lifecycle: one line, ids present, error path.',
    ],
  },
  {
    id: 'bun',
    letter: 'B',
    label: 'Bun · Elysia',
    sub: 'Elysia plugin + macros · BullMQ',
    adds: 'Bun · Elysia adds 5 lines: a named logging plugin (derive + onAfterResponse + onError), plain log handles for services, BullMQ job ids, and lifecycle tests.',
    notes: [
      '- pino is built once in platform/logger.ts with `base: { service, env, version, commit_sha }`; keep its epoch-ms time.',
      '- One named plugin plugins/logging.ts: `derive` sets `request_id` (incoming `x-request-id` or a new `req_` id) and a per-request `log` with `set()` / `call()`; `onAfterResponse` writes the one canonical line; `onError` records the structured error so throws still log. Set the `x-request-id` response header there too.',
      '- Handlers call `log.set({ ... })` / `log.call({ ... })` and pass plain values to services; never pass the whole context.',
      '- BullMQ: `request_id` in job data; the worker binds `logger.child({ job_id, request_id })`. BullMQ rejects custom jobIds that contain `:`, so use `-` there (`payout-88-1300`) and log `job_id` as `payout:88:1300`.',
      '- Tests: `app.handle(new Request(...))` through the full lifecycle: one line, ids present, error path.',
    ],
  },
  {
    id: 'python',
    letter: 'P',
    label: 'Python · structlog',
    sub: 'FastAPI, Django, Flask · Celery, RQ',
    adds: 'Python · structlog adds 5 lines: JSON renderer config, contextvars for the request, one middleware, Celery/RQ ids, and pytest coverage.',
    notes: [
      '- Configure structlog once: `merge_contextvars`, `add_log_level`, `TimeStamper(fmt="iso", key="timestamp")`, `JSONRenderer()`; bind `service`, `env`, `version` at startup. Route stdlib logging through it so uvicorn/gunicorn lines are JSON too.',
      '- One middleware (Starlette/FastAPI `BaseHTTPMiddleware`, Django middleware, Flask `before_request`/`teardown_request`) binds `request_id` (incoming `x-request-id` or a new `req_` id) with `structlog.contextvars.bind_contextvars`, times the request, and logs the single canonical line in `finally`; it sets the `x-request-id` response header.',
      '- Handlers add fields with a small helper (`log_set(user_id=...)`, `log_call(provider=..., action=..., at_ms=...)`) stored in a contextvar dict; never log inside every function.',
      '- Celery/RQ: pass `request_id` in the task kwargs or headers; a task prerun/postrun hook binds `job_id` (`<queue>:<entity>:<n>`) and `request_id` and logs the lifecycle lines.',
      '- Tests: pytest with the test client and `structlog.testing.capture_logs()`: one line, ids present, error path.',
    ],
  },
  {
    id: 'go',
    letter: 'G',
    label: 'Go · slog',
    sub: 'net/http, chi, echo · Asynq, River',
    adds: 'Go · slog adds 5 lines: one JSON handler, a context-carried request log, a wrapping middleware, Asynq/River ids, and httptest coverage.',
    notes: [
      '- One `slog.New(slog.NewJSONHandler(os.Stdout, ...))` with `service`, `env`, `version` attached via `.With(...)`; rename the time key to `time` only once and keep a single timestamp.',
      '- One middleware wraps the handler: reads or creates `request_id` (incoming `X-Request-Id` or a new `req_` id), stores a per-request field bag in `context.Context`, wraps the ResponseWriter to capture `status`, and writes the canonical line in a deferred func (recover panics there too); it sets the `X-Request-Id` response header.',
      '- Handlers call `logx.Set(ctx, "user_id", id)` / `logx.Call(ctx, ...)`; pass ids, not the request.',
      '- Asynq/River: put `request_id` in the task payload; the worker middleware logs `job_id` (`<queue>:<entity>:<n>`) and `request_id` on every lifecycle line.',
      '- Tests: `httptest` through the middleware: one line, ids present, error and panic path.',
    ],
  },
  {
    id: 'other',
    letter: '·',
    label: 'Other',
    sub: 'any JSON logger · agent asks first',
    adds: 'Other adds 3 lines: the agent names the logger and framework it found and asks before choosing where the canonical line lives.',
    notes: [
      '- Name the logger, HTTP framework and job library you found, and propose where the request and job wrappers go before writing code; ask if there is more than one candidate.',
      '- Use whatever request-scoped context the platform has (thread locals, request extensions, context objects) for `request_id` and the per-request field bag.',
      '- If the logger cannot emit JSON, add a JSON formatter to it rather than a second logger.',
    ],
  },
]

export const DEFAULT_STACK: StackId = 'node'

export const stackById = (id: string | undefined): Stack => STACKS.find((s) => s.id === id) ?? STACKS[0]

/** The prompt body: everything below the `---` line in the doc. */
export const BASE_PROMPT = (() => {
  const i = promptDoc.indexOf('\n---\n')
  return (i >= 0 ? promptDoc.slice(i + 5) : promptDoc).trim()
})()

/** The full prompt for a stack: the base with `## Stack notes (…)` before `## Done when`. */
export function promptFor(id: StackId): string {
  const s = stackById(id)
  const notes = `## Stack notes (${s.label})\n${s.notes.join('\n')}\n\n`
  const at = BASE_PROMPT.indexOf('## Done when')
  return at >= 0 ? `${BASE_PROMPT.slice(0, at)}${notes}${BASE_PROMPT.slice(at)}\n` : `${BASE_PROMPT}\n\n${notes}`
}

/** `## ` headings with their 1-based line numbers (the "In this prompt" index). */
export function promptSections(text: string): { line: number; title: string }[] {
  return text
    .split('\n')
    .map((l, i) => ({ line: i + 1, l }))
    .filter(({ l }) => l.startsWith('## '))
    .map(({ line, l }) => ({ line, title: l.slice(3) }))
}

/** The "Done when" bullets, as the checklist on the agent tab. */
export const DONE_ITEMS: { title: string; sub: string }[] = [
  { title: 'One request → exactly one canonical line', sub: 'the job it enqueues logs the same request_id' },
  { title: 'A thrown error still logs the line', sub: 'status, outcome: "failed", structured error' },
  { title: 'Tests cover the middleware and the job wrapper', sub: 'one line, ids present, error path' },
  { title: 'docs/logging.md explains fields and calls', sub: '' },
  { title: 'The agent shows 3 example lines', sub: 'success, failed request, job retry' },
]

export const fmtKB = (s: string) => `${(new Blob([s]).size / 1024).toFixed(1)} KB`

/** Copy the prompt for a stack, with the "copied" toast (also ⌘⇧C). */
export async function copyPrompt(id: StackId): Promise<boolean> {
  const text = promptFor(id)
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Prompt copied', {
      description: `${PROMPT_FILE} · ${text.split('\n').length} lines · ${stackById(id).label} notes. Paste it into your agent at the root of the repo.`,
    })
    return true
  } catch {
    toast.error('Could not copy', { description: 'Select the prompt and copy it by hand.' })
    return false
  }
}

const STACK_KEY = 'quiet.guide.stack'

/** The stack picked on the Guide in this browser (Node · pino until one is picked). */
export function stackNow(): StackId {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(STACK_KEY) : null
  return STACKS.some((s) => s.id === v) ? (v as StackId) : DEFAULT_STACK
}

/** The picked stack, remembered in this browser. */
export function useStack(): [StackId, (s: StackId) => void] {
  const [stack, setStack] = useState<StackId>(stackNow)
  useEffect(() => {
    localStorage.setItem(STACK_KEY, stack)
  }, [stack])
  return [stack, setStack]
}

/** Download the prompt as a .md file. */
export function downloadPrompt(id: StackId) {
  const blob = new Blob([promptFor(id)], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = PROMPT_FILE
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
