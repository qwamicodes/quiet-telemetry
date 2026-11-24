import { useCallback, useEffect, useState } from 'react'
import promptDoc from '@/guide/agent-logging-prompt.md?raw'
import templatesDoc from '@/guide/logging-product-templates.md?raw'
import { toast } from '@/lib/toast'

/**
 * Guide (boards v0.1-11.x, v0.1.1-11.x): the agent prompt and the stack notes added to it.
 * `src/guide/agent-logging-prompt.md` is a copy of `docs/agent-logging-prompt.md`
 * (a test keeps the two identical); the prompt is everything below its `---`.
 */
export const PROMPT_FILE = 'agent-logging-prompt.md'

export type StackId = 'node' | 'bun' | 'python' | 'go' | 'rust' | 'other'

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
    sub: 'Express, Fastify, Hono · existing logger',
    adds: 'Node · pino adds 5 lines: one pino base, a request-local event in AsyncLocalStorage, completion middleware, native queue ids, and lifecycle tests.',
    notes: [
      '- Build pino once with `base: { service, env, version, commit_sha }` and an ISO `timestamp`; keep a single time key.',
      '- One middleware creates the request-local event in AsyncLocalStorage, sets or validates `request_id`, starts a monotonic timer and emits once on the real completion boundary (`res.on("finish")` / `"close"` in Express, `onResponse` in Fastify, a try/finally around `await next()` in Hono or Koa). It sets the `x-request-id` response header.',
      '- Handlers read the event and assign fields directly (`event.flow = "create_order"`, `event.order = { id }`); pass plain values to services, never the request.',
      '- Queues: keep the native job id (BullMQ `job.id`, e.g. `payout-88-1300`) as `job_id` with `queue` and the attempt number; propagate `request_id` in job data; one completion event per attempt from the worker wrapper.',
      '- Tests: supertest (or `app.inject`) through the full lifecycle: one event, ids present, error, abort and redaction paths.',
    ],
  },
  {
    id: 'bun',
    letter: 'B',
    label: 'TypeScript · Elysia',
    sub: 'Plugin · existing logger and queue',
    adds: 'TypeScript · Elysia adds 5 lines: the logging plugin plus fetch wrapper, direct enrichment in handlers, native queue ids, and lifecycle tests.',
    notes: [
      '- Keep the existing logger and transport; configure one UTC timestamp and shared service/deployment fields. Do not add a second logger.',
      '- Install both `logging.plugin` before routes and `logging.fetch` around `app.handle` (see `examples/logging/typescript/`). Together they capture errors and local response-body EOF, error or cancellation. Confirm hooks against the installed version; no private framework API.',
      '- Handlers assign `wideEvent.flow`, `wideEvent.user` and other business fields directly. Middleware-owned ids and timing stay protected; handlers never emit early.',
      '- Queues: keep the native job id as `job_id` with `queue` and the attempt number; propagate `request_id` in job data; one completion event per attempt.',
      '- Tests: `app.handle(new Request(...))` through the full lifecycle: one event, ids present, error, abort and redaction paths.',
    ],
  },
  {
    id: 'python',
    letter: 'P',
    label: 'Python · ASGI',
    sub: 'ASGI middleware · existing logger',
    adds: 'Python · ASGI adds 5 lines: one JSON logger, an ASGI middleware around the whole app, contextvar enrichment, native task ids, and pytest coverage.',
    notes: [
      '- Configure the existing logger (structlog or stdlib) once to emit JSON with an ISO `timestamp` and `service`, `env`, `version`; route uvicorn/gunicorn logs through it.',
      '- Wrap the whole app outside its error-to-response middleware (see `examples/logging/python/`). The final ASGI body/trailer send defines local completion; emit once there, including on exceptions and disconnects. Set the `x-request-id` response header.',
      '- Handlers get the event from `scope` or a contextvar and assign fields directly (`event["flow"] = "create_order"`).',
      '- Celery/RQ/Arq: keep the native task id as `job_id` with `queue` and the retry count; propagate `request_id` in headers or kwargs; one completion event per attempt from the task wrapper.',
      '- Tests: pytest with the ASGI test client through the full lifecycle: one event, ids present, error, disconnect and redaction paths.',
    ],
  },
  {
    id: 'go',
    letter: 'G',
    label: 'Go · net/http',
    sub: 'Handler + response writer',
    adds: 'Go · net/http adds 5 lines: one slog JSON handler, a wrapping middleware with a response writer, synchronized enrichment, native task ids, and httptest coverage.',
    notes: [
      '- One `slog.New(slog.NewJSONHandler(os.Stdout, ...))` with `service`, `env`, `version` attached once; keep a single `timestamp` key.',
      '- Wrap the mux (see `examples/logging/go/`): read or create `request_id`, put the request-local event in `context.Context`, wrap the ResponseWriter to capture `status_code` and bytes, and emit once in a deferred func that also recovers panics. Set the `X-Request-Id` response header.',
      '- Handlers enrich the event map from the context (`event["flow"] = "create_order"`); keep concurrent writes synchronized and preserve HTTP behaviour.',
      '- Asynq/River: keep the native task id as `job_id` with `queue` and the retry count; propagate `request_id` in the payload; one completion event per attempt.',
      '- Tests: `httptest` through the middleware: one event, ids present, error, panic and redaction paths.',
    ],
  },
  {
    id: 'rust',
    letter: 'R',
    label: 'Rust · Axum',
    sub: 'Middleware + response body wrapper',
    adds: 'Rust · Axum adds 5 lines: one tracing JSON subscriber, a middleware with a response-body wrapper, a shared event in request extensions, native job ids, and tests.',
    notes: [
      '- Configure the existing `tracing` subscriber once to emit JSON with an ISO `timestamp` and `service`, `env`, `version`.',
      '- Add middleware that puts a shared, synchronized event in request extensions and wraps the response body (see `examples/logging/rust/`); the body wrapper observes completion, errors and drops and emits once. Set the `x-request-id` response header.',
      '- Handlers take `Extension<SharedEvent>`, lock it briefly to insert fields (`flow`, `order`), and release the lock before awaiting.',
      '- Queues (apalis, custom workers): keep the native job id as `job_id` with `queue` and the attempt number; propagate `request_id`; one completion event per attempt.',
      '- Tests: `tower::ServiceExt::oneshot` through the full lifecycle: one event, ids present, error, drop and redaction paths.',
    ],
  },
  {
    id: 'other',
    letter: '?',
    label: 'Detect from codebase',
    sub: 'Existing framework, logger and queue',
    adds: 'Detect from codebase adds 3 lines: the agent names the framework, logger and queue it found and asks before choosing where the event lives.',
    notes: [
      '- Name the logger, HTTP framework and job/queue systems you found (with versions), and propose where the request and job wrappers go before writing code; ask only if there is more than one candidate.',
      "- Use the platform's request-scoped context (async locals, contextvars, request extensions, context objects) for the request-local event.",
      '- If the logger cannot emit JSON, add a JSON formatter to it rather than a second logger.',
    ],
  },
]

export const DEFAULT_STACK: StackId = 'node'

export const stackById = (id: string | undefined): Stack =>
  STACKS.find((s) => s.id === id) ?? (STACKS.find((s) => s.id === DEFAULT_STACK) as Stack)

/** The language picker order on the boards (v0.1.1-11.1 / 11.4): Detect first. */
export const STACK_ORDER: StackId[] = ['other', 'node', 'bun', 'python', 'go', 'rust']

/** The `Language/framework` line of the reviewed inputs. */
const STACK_LINE: Record<StackId, string> = {
  node: 'Node / pino; detect the installed framework and version',
  bun: 'TypeScript / Elysia; detect installed version',
  python: 'Python / ASGI; detect the installed framework and version',
  go: 'Go / net/http; detect installed version',
  rust: 'Rust / Axum; detect installed version',
  other: 'detect from the codebase; detect installed versions',
}

// ---- Prompt setup (v0.1.1-11.1 … 11.3, 11.7 … 11.9) ----------------------------------

export type GoalOp = 'under' | 'within'
export type GoalUnit = 'ms' | 'seconds' | 'minutes'
export type GoalKind = 'request' | 'job'
export type GoalMatters = 'speed_success' | 'success' | 'speed'

/** One reliability goal (an SLO) the prompt asks the agent to measure. */
export type Goal = {
  id: string
  /** Template key (`tickets-checkout`) or a slug of the name. */
  key: string
  name: string
  /** Product pack name when it came from a template. */
  template?: string
  /** What it applies to, in plain words ("Order requests"). */
  appliesTo: string
  /** Where it lives, if known ("legivent-api · POST /api/v1/orders"). */
  scope: string
  kind: GoalKind
  matters: GoalMatters
  op: GoalOp
  limit: number
  unit: GoalUnit
  /** Percent of eligible units, e.g. 99.9. */
  target: number
  /** Rolling period in days. */
  period: number
  /** More options: the measurement boundary, success rules and exclusions. */
  timing: string
  rules: string
  exclusions: string
  /** Set on the goals of the last template addition (the "Added" tag and Undo). */
  batch?: string
}

export type Setup = {
  /** `service / environment`. */
  app: string
  /** The project a template is added to (a source name). */
  project: string
  /** Product type: the recommended product pack. */
  productType: string
  /** The queue / worker library, if the owner named it (Sources → Logging setup, 06.4). */
  queue: string
  goals: Goal[]
  /** Routine (ordinary-completion) sample rate in percent. */
  sample: number
  otherRules: string
  headers: 'approved' | 'none'
  alsoHide: string
  /** The last template addition, for the banner and Undo. */
  lastAdd?: { batch: string; pack: string; count: number; existing: number }
}

export const SETUP_DEFAULTS: Setup = {
  app: '',
  project: '',
  productType: '',
  queue: '',
  goals: [],
  sample: 100,
  otherRules: '',
  headers: 'approved',
  alsoHide: '',
}

export const SAMPLE_RATES = [100, 50, 25, 10, 5, 1]
export const PERIODS = [30, 28, 7]

const SETUP_KEY = 'quiet.guide.setup'

export function readSetup(): Setup {
  try {
    const v = JSON.parse(localStorage.getItem(SETUP_KEY) ?? '{}') as Partial<Setup>
    return { ...SETUP_DEFAULTS, ...v, goals: Array.isArray(v.goals) ? v.goals : [] }
  } catch {
    return SETUP_DEFAULTS
  }
}

/** Change the remembered setup outside a `useSetup` (a link that also picks the project). */
export function patchSetup(patch: Partial<Setup>) {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify({ ...readSetup(), ...patch }))
  } catch {
    // private mode: nothing remembered
  }
}

/** The prompt setup, remembered in this browser. */
export function useSetup(): [Setup, (patch: Partial<Setup> | ((s: Setup) => Partial<Setup>)) => void] {
  const [setup, set] = useState<Setup>(readSetup)
  const update = useCallback((patch: Partial<Setup> | ((s: Setup) => Partial<Setup>)) => {
    set((prev) => {
      const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }
      try {
        localStorage.setItem(SETUP_KEY, JSON.stringify(next))
      } catch {
        // private mode: this session only
      }
      return next
    })
  }, [])
  return [setup, update]
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

let seq = 0
export const newId = () => `g${Date.now().toString(36)}${(seq++).toString(36)}`

export function blankGoal(kind: GoalKind = 'request'): Goal {
  return {
    id: newId(),
    key: '',
    name: '',
    appliesTo: '',
    scope: '',
    kind,
    matters: 'speed_success',
    op: kind === 'job' ? 'within' : 'under',
    limit: kind === 'job' ? 30 : 500,
    unit: kind === 'job' ? 'seconds' : 'ms',
    target: 99.9,
    period: 30,
    timing: '',
    rules: '',
    exclusions: '',
  }
}

const UNIT_MS: Record<GoalUnit, number> = { ms: 1, seconds: 1000, minutes: 60_000 }
const UNIT_SHORT: Record<GoalUnit, [string, string]> = {
  ms: ['ms', 'ms'],
  seconds: ['sec', 'sec'],
  minutes: ['min', 'min'],
}
const UNIT_LONG: Record<GoalUnit, [string, string]> = {
  ms: ['millisecond', 'milliseconds'],
  seconds: ['second', 'seconds'],
  minutes: ['minute', 'minutes'],
}

export const limitMs = (g: Pick<Goal, 'limit' | 'unit'>) => g.limit * UNIT_MS[g.unit]

/** `99.9% under 500 ms` */
export function fmtTarget(g: Pick<Goal, 'target' | 'op' | 'limit' | 'unit'>, long = false): string {
  const u = (long ? UNIT_LONG : UNIT_SHORT)[g.unit][g.limit === 1 ? 0 : 1]
  return `${g.target}% ${g.op} ${g.limit} ${u}`
}

/** `Order requests · 99.9% under 500 ms · last 30 days` */
export const goalLine = (g: Goal) => [g.appliesTo, fmtTarget(g), `last ${g.period} days`].filter(Boolean).join(' · ')

/** The sentence under the goal form. */
export function goalHint(g: Goal): string {
  const what = g.kind === 'job' ? 'Jobs' : 'Requests'
  if (g.matters === 'success') return `${what} must finish without errors. Errors and cancelled work count as misses.`
  if (g.matters === 'speed') return `${what} must finish in time. Correct business rejections count when they're fast.`
  return g.kind === 'job'
    ? 'Jobs must finish successfully in time, including waiting and retries. Failed and cancelled jobs count as misses.'
    : 'Requests must finish without errors. Errors and cancelled requests count as misses.'
}

// ---- Product templates (docs/logging-product-templates.md) ------------------------------

export type TemplateGoal = {
  key: string
  name: string
  /** The suggested target as written ("99% under 2 seconds"). */
  text: string
  target: number
  op: GoalOp
  limit: number
  unit: GoalUnit
  /** "One valid ticket-checkout API submission, from request start to …" */
  unitDesc: string
  good: string
}

export type ProductPack = { id: string; name: string; blurb: string; notes: string; goals: TemplateGoal[] }

function parseTarget(t: string): Pick<TemplateGoal, 'target' | 'op' | 'limit' | 'unit'> {
  const m = t.match(/^([\d.]+)% (under|within) ([\d.]+) (seconds?|minutes?|ms|milliseconds?)/)
  if (!m) return { target: Number.parseFloat(t) || 99, op: 'within', limit: 1, unit: 'seconds' }
  const u = m[4].startsWith('min') ? 'minutes' : m[4].startsWith('ms') || m[4].startsWith('milli') ? 'ms' : 'seconds'
  return { target: Number(m[1]), op: m[2] as GoalOp, limit: Number(m[3]), unit: u }
}

/** The 20 product packs, parsed from the templates doc. */
export const PACKS: ProductPack[] = (() => {
  const body = templatesDoc.slice(
    templatesDoc.indexOf('\n## Payment system'),
    templatesDoc.indexOf('\n## Shared measurement'),
  )
  return body
    .split('\n## ')
    .filter((c) => c.trim())
    .map((chunk) => {
      const lines = chunk.split('\n')
      const name = lines[0].trim()
      const rows = lines.filter((l) => /^\| .+ \/ `[^`]+` \|/.test(l))
      const goals = rows.map((r) => {
        const [g, text, unitDesc, good] = r
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim())
        const [gname, key] = g.split(' / ')
        return {
          key: key.replace(/`/g, ''),
          name: gname,
          text,
          ...parseTarget(text),
          unitDesc,
          good,
        }
      })
      const tableEnd = lines.findIndex((l, i) => i > 0 && l.startsWith('|') && !lines[i + 1]?.startsWith('|'))
      const blurb = lines.slice(1).find((l) => l.trim() && !l.startsWith('|')) ?? ''
      const notes = lines
        .slice(tableEnd + 1)
        .filter((l) => l.trim())
        .join('\n')
      return { id: slug(name), name, blurb: blurb === notes.split('\n')[0] ? '' : blurb, notes, goals }
    })
})()

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** "One valid ticket-checkout API submission, from …" → "Valid ticket-checkout API submissions" */
export function appliesToOf(t: TemplateGoal): string {
  const head = t.unitDesc.split(/, from |, measured /)[0].replace(/^One /, '')
  const words = head.split(' ')
  const last = words.length - 1
  if (!/s$/.test(words[last])) words[last] = `${words[last]}s`
  return cap(words.join(' '))
}

/** "from request start to local response-body completion" */
export const timingOf = (t: TemplateGoal) => {
  const m = t.unitDesc.match(/, from (.+)$/)
  return m ? m[1] : ''
}

export const isRequestGoal = (t: TemplateGoal) =>
  /request|submission|API|search|query|scan/i.test(t.unitDesc.split(',')[0])

export function goalFromTemplate(t: TemplateGoal, pack: ProductPack, period: number, batch: string): Goal {
  return {
    id: newId(),
    key: t.key,
    name: t.name,
    template: pack.name,
    appliesTo: appliesToOf(t),
    scope: '',
    kind: isRequestGoal(t) ? 'request' : 'job',
    matters: 'speed_success',
    op: t.op,
    limit: t.limit,
    unit: t.unit,
    target: t.target,
    period,
    timing: timingOf(t),
    rules: t.good,
    exclusions: isRequestGoal(t) ? 'malformed requests and test traffic' : 'test traffic only',
    batch,
  }
}

// ---- The prompt ----------------------------------------------------------------------------

/** The prompt body: everything below the `---` line in the doc. */
export const BASE_PROMPT = (() => {
  const i = promptDoc.indexOf('\n---\n')
  return (i >= 0 ? promptDoc.slice(i + 5) : promptDoc).trim()
})()

const section = (text: string, title: string) => {
  const at = text.indexOf(`## ${title}`)
  if (at < 0) return null
  const next = text.indexOf('\n## ', at + 3)
  // A section ends at the next heading, or at the closing paragraph after Done when.
  return { at, end: next < 0 ? text.length : next + 1 }
}

/** Replace `## title` up to the next heading, or up to `until` when given. */
const replaceSection = (text: string, title: string, body: string, until?: string) => {
  const s = section(text, title)
  if (!s) return text
  const stop = until ? text.indexOf(until, s.at) : -1
  const end = stop >= 0 ? stop + 1 : s.end
  return `${text.slice(0, s.at)}${body}\n\n${text.slice(end).replace(/^\n+/, '')}`
}

function goalBlock(g: Goal, i: number): string {
  const ms = limitMs(g)
  const cmp = g.op === 'under' ? `<${ms} ms` : `within ${ms} ms (inclusive)`
  const good =
    g.rules && g.template
      ? `${g.rules} (${g.op === 'under' ? '<' : '≤'}${ms} ms)`
      : g.kind === 'job'
        ? g.matters === 'speed'
          ? `completion ${cmp}`
          : `broker-confirmed success ${cmp}`
        : g.matters === 'success'
          ? 'completed response, status <400, no recorded error'
          : g.matters === 'speed'
            ? `completed response ${cmp}`
            : `completed response, status <400, no recorded error, duration ${cmp}`
  const timing =
    g.timing ||
    (g.kind === 'job'
      ? 'accepted to terminal completion, including waiting and retries'
      : 'request start to local response-body completion')
  return [
    `Goal ${i + 1} — ${g.key || slug(g.name) || `goal-${i + 1}`} — ${g.name || 'Unnamed goal'}`,
    g.template && `Product template: ${g.template}`,
    `Scope: ${[g.scope, g.appliesTo].filter(Boolean).join(' · ') || 'map to actual routes or queues'}${g.template ? '; map to actual routes and queues' : ''}`,
    `Good: ${good}`,
    !g.template && g.rules && `Success rules: ${g.rules}`,
    `Timing: ${timing}`,
    `${g.kind === 'job' ? 'Cancelled jobs' : 'Aborted requests'}: eligible and bad · ${g.exclusions ? `exclude ${g.exclusions}` : 'no exclusions'}`,
    `Target: ${g.target}% over rolling ${g.period} days`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** The `## Reviewed inputs` block for a stack and setup (11.2). */
export function reviewedInputs(id: StackId, s: Setup): string {
  const hide = s.alsoHide
    .split(/[,·\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
  const jobs = s.goals.filter((g) => g.kind === 'job')
  return [
    '## Reviewed inputs',
    `Language/framework: ${STACK_LINE[id]}`,
    `Service/environment: ${s.app.trim() || 'detect from the codebase'}`,
    `Queue: ${s.queue.trim() ? `${s.queue.trim()}; ` : ''}inspect the codebase${jobs.length ? ` and map ${jobs.map((g) => g.name || g.appliesTo).join(', ')} to the actual queue` : "; keep each queue's native ids"}`,
    '',
    ...(s.goals.length
      ? s.goals.flatMap((g, i) => [goalBlock(g, i), ''])
      : ['Goals: none configured. Do not invent targets or activate examples.', '']),
    `Ordinary-completion sample rate: ${s.sample}%${s.sample === 100 ? ' (keep every event)' : ''}`,
    `Additional business retention: ${s.otherRules.trim() || 'none'}`,
    `Headers: ${s.headers === 'approved' ? 'approved request/response metadata' : 'none captured'}`,
    'Bodies: both disabled; no route opt-ins',
    'Body/event limits: 8192/32768 serialized UTF-8 bytes (measured after redaction)',
    `Redact: passwords, tokens, API keys, authorization, cookies and any configured fields${hide.length ? `; ${hide.join(', ')}` : ''}`,
    'Keep visible: email, phone/MSISDN',
  ].join('\n')
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

/** `## Sampling` once goals exist: each goal on its own definition (11.2). */
function goalSampling(s: Setup): string {
  const n = s.goals.length
  const count = NUMBER_WORDS[n] ?? String(n)
  return [
    '## Sampling',
    `Implement \`shouldSample(event)\`. Evaluate all ${n === 1 ? 'one' : count} configured ${n === 1 ? 'goal' : 'goals'} independently using their own definitions above.${n > 1 ? " Do not apply one goal's time limit or success rule to another." : ''}`,
    'Correctly handled business declines or rejections can meet a product goal. HTTP ≥400 still follows the agreed error-level and retention mapping; a retained error log is not automatically an SLO miss.',
    'Measure all eligible work before sampling. Logical-job goals require durable start, completion and deadline evidence; count each logical unit once across retries. Missing observation coverage stays unknown. An observed deadline miss is bad; do not invent a completion event to represent it.',
    `Retain any observed event that misses an applicable goal, plus warn/error events, HTTP ≥400, failed job attempts, forced retention and confirmed retry recovery. Keep the rest at ${s.sample}%. One event may inform several goals; do not combine their denominators or emit it twice. A single missed goal is not an aggregate SLO breach.`,
  ].join('\n')
}

/** The full prompt: reviewed inputs from the setup, the base, and `## Stack notes (…)` before `## Done when`. */
export function promptFor(id: StackId, setup: Setup = readSetup()): string {
  const s = stackById(id)
  let text = replaceSection(BASE_PROMPT, 'Reviewed inputs', reviewedInputs(id, setup), '\nAdapt ')
  if (setup.goals.length) text = replaceSection(text, 'Sampling', goalSampling(setup))
  const notes = `## Stack notes (${s.label})\n${s.notes.join('\n')}\n\n`
  const at = text.indexOf('## Done when')
  return at >= 0 ? `${text.slice(0, at)}${notes}${text.slice(at)}\n` : `${text}\n\n${notes}`
}

/** `## ` headings with their 1-based line numbers (the "In this prompt" index). */
export function promptSections(text: string): { line: number; title: string }[] {
  return text
    .split('\n')
    .map((l, i) => ({ line: i + 1, l }))
    .filter(({ l }) => l.startsWith('## '))
    .map(({ line, l }) => ({ line, title: l.slice(3) }))
}

/** "Done looks like" on the language examples (11.4). */
export const DONE_ITEMS: { title: string; sub: string }[] = [
  { title: 'One completion event per execution', sub: 'Tail sampling chooses which events are emitted' },
  { title: 'Errors and SLO misses are retained', sub: 'Measure every eligible unit before sampling' },
  { title: 'Tests cover the middleware and the job wrapper', sub: 'completion, redaction, sampling and SLOs' },
  { title: 'docs/logging.md explains context and SLOs', sub: '' },
  { title: 'Examples cover requests and workers', sub: 'errors, capture, retries and child jobs' },
]

/** "What happens next" on the setup (11.1). */
export const NEXT_ITEMS: { title: string; sub: string }[] = [
  { title: 'Choose your goals', sub: 'Start with a template or add your own' },
  { title: 'Review your prompt', sub: 'All your goals and logging choices in one place' },
  { title: 'Give it to your coding agent', sub: 'It adds the logging and checks it works' },
  { title: 'Errors and missed goals are always kept', sub: '' },
  { title: 'You can change your goals later', sub: 'Update your setup and generate a new prompt' },
]

/** "What your agent will do" on the review (11.2). */
export const AGENT_ITEMS: { title: string; sub: string }[] = [
  { title: 'Add one clear log for each piece of work', sub: 'Requests, job attempts and scheduled runs' },
  { title: 'Keep errors and missed goals', sub: 'Measure every goal, even when routine logs are reduced' },
  { title: 'Check that the logging works', sub: 'Including errors, private data and retries' },
  { title: 'Write a short guide for your codebase', sub: '' },
  { title: 'Report anything it could not verify', sub: 'Including queue completion and goal measurements' },
]

export const fmtKB = (s: string) => `${(new Blob([s]).size / 1024).toFixed(1)} KB`

/** Copy the prompt for a stack, with the "copied" toast and its Verify next action (also ⌘⇧C). */
export async function copyPrompt(id: StackId, verify?: () => void): Promise<boolean> {
  const setup = readSetup()
  const text = promptFor(id, setup)
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Prompt copied', {
      description: `${stackById(id).label} notes${setup.goals.length ? ' and your SLOs' : ''} included`,
      button: {
        title: 'Verify next',
        onClick: verify ?? (() => window.location.assign('/guide?tab=check')),
      },
    })
    window.dispatchEvent(new Event(PROMPT_COPIED))
    return true
  } catch {
    toast.error('Could not copy', { description: 'Select the prompt and copy it by hand.' })
    return false
  }
}

/** Fired after a successful copy: the stepper moves to "Apply in your repo". */
export const PROMPT_COPIED = 'quiet:prompt-copied'

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

// ---- Verify your logs (v0.1.1-11.6) -----------------------------------------------------

/** Board titles where the server's differ. */
export const CHECK_TITLE: Record<string, string> = { job_id: 'job_id on job lines' }

/** The short "→" fix under a check. */
export const SHORT_FIX: Record<string, string> = {
  json: 'Print one JSON object per line',
  timestamp: 'Keep one UTC completion timestamp',
  level: 'Map levels to debug / info / warn / error',
  deployment: 'Add when available; do not invent a version',
  canonical: 'Emit one completion event per request',
  request_id: 'Return x-request-id on every response',
  job_id: "Log the queue's own job id",
  job_scope: 'Bare ids may repeat across queues',
  job_request_id: 'Check expected parents; standalone jobs are valid',
  attempt: 'Add duration_ms and the native attempt',
  error_object: 'Preserve typed error reason and details',
  capture: 'Optional: safe fields and byte limits',
}

/** One numbered step of the fix prompt, per check. */
const FIX_STEP: Record<string, string> = {
  json: 'Configure the existing logger to print one JSON object per line to stdout.',
  timestamp: 'Keep one UTC completion timestamp and monotonic duration.',
  level: 'Map levels to debug, info, warn and error: error for a recorded error or HTTP ≥400, warn for a slow success.',
  deployment: 'Set service, env and version or commit_sha once in the logger base; do not invent a version.',
  canonical: 'Build one completion event per request in middleware and emit it once; drop scattered progress lines.',
  request_id:
    'Accept x-request-id only from trusted upstreams, otherwise generate one; return it as a response header.',
  job_id: 'Keep native id + queue + service. Propagate only evidenced parents; standalone jobs are valid.',
  job_scope: 'Keep native id + queue + service. Propagate only evidenced parents; standalone jobs are valid.',
  job_request_id: 'Keep native id + queue + service. Propagate only evidenced parents; standalone jobs are valid.',
  attempt: "Write one completion event per attempt with duration_ms and the queue's own attempt number.",
  error_object: 'Normalize error strings to message; preserve safe reason and details types.',
  completion: 'Verify missing terminal evidence with the queue. Do not infer completion from a missing log.',
}

const FIX_LAST =
  'Run redaction and retention tests. Measure all eligible work before sampling; verify SLO coverage separately.'

/** The "Fix with your agent" prompt for a source's findings. */
export function fixPrompt(source: string, checks: { id: string; status: string }[]): string {
  const steps = [
    ...new Set(
      checks
        .filter((c) => ['fail', 'warn', 'review'].includes(c.status))
        .map((c) => FIX_STEP[c.id])
        .filter(Boolean),
    ),
    FIX_LAST,
  ]
  return [`Review ${source} using the existing logger.`, ...steps.map((s, i) => `${i + 1}. ${s}`)].join('\n')
}

/** Where the language examples live. */
export const EXAMPLES_URL = 'https://github.com/qwamicodes/quiet-telemetry/tree/main/examples/logging'
export const exampleReadme = (lang: string) =>
  `https://github.com/qwamicodes/quiet-telemetry/blob/main/examples/logging/${lang}/README.md`
