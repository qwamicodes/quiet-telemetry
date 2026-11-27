# quiet · Elysia · Levels and error shape

Follow the style rules and run order in `SKILL.md`. Tested on Elysia 1.4.32, Bun 1.4
and pino 10.

## Goal
Each line's `level` says how the request went, and its `error` says what broke and
why, in plain fields: the error's real type, a readable message, its details and its
cause. A validation failure lists what was wrong without repeating what was sent.

The levels are the same in every project:

| Level | Meaning | Examples |
|---|---|---|
| `error` | The request didn't do what was asked | any 4xx or 5xx: 401, 404, 422, 500 |
| `warn` | It worked, but not cleanly | an error was handled with `log.capture`, or it was slow |
| `info` | It worked cleanly | everything else |

A failure is always `error`, even if it was also slow. Noise from expected 4xx (bots
probing for pages, expired tokens) is handled by sampling, not by lowering the level.

Not in this phase: headers and redaction, sampling, jobs, request/response bodies.

## Step 1 — Look first
List (file:line):
- error classes in the codebase (domain errors such as `PaymentError`), what they
  carry and which HTTP status each one returns today;
- any `onError` handlers or error-mapping plugins;
- `catch` blocks that log an error and carry on (`console.error`, `logger.error`)
  instead of rethrowing.
Stop.

## Step 2 — Choose the rules
Ask the user to select one for each:

**Stack traces**
1. Never.
2. Outside production only.
3. Always.

**Domain error statuses** (a thrown domain error returns 500 unless its class says otherwise)
1. Leave them as they are.
2. Give error classes a `status` (such as 402 for a declined payment). This changes
   what the API returns, so confirm each class with the user.

Stop. The stack choice becomes a constant in Step 3.

## Step 3 — Constants
Add to the constants file, with the selected values:

```ts
export const LOG_STACK = ENV !== 'production' // never: false, always: true
export const MAX_VALIDATION_ISSUES = 5
```

`SLOW_MS` is already there.

## Step 4 — Error shape
Add an errors file next to the request event file (propose the path if the Layout
doesn't list one):

```ts
import { ValidationError } from 'elysia'
import { LOG_STACK, MAX_VALIDATION_ISSUES } from '<constants path>'

/** Turn any thrown value into a readable, structured error for the request line. */
export function errorFields(error: unknown, code?: string): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) }
  const fields: Record<string, unknown> = {
    name: error.name === 'Error' ? error.constructor.name : error.name,
    message: error.message,
  }
  if (code && code !== 'UNKNOWN') fields.code = code
  if (error instanceof ValidationError) {
    fields.message = `invalid ${error.type}`
    fields.details = {
      on: error.type,
      issues: error.all.slice(0, MAX_VALIDATION_ISSUES).map((issue) => ({ path: issue.path, summary: issue.summary })),
    } // never error.value: it is the data the client sent
  } else if ('details' in error) {
    fields.details = error.details
  }
  if (error.cause instanceof Error) fields.cause = { name: error.cause.name, message: error.cause.message }
  if (LOG_STACK && error.stack) fields.stack = error.stack
  return fields
}
```

Why each line is there:
- Elysia's own errors all report `name: "Error"`; the real type is the constructor
  (`ValidationError`, `ParseError`, `NotFoundError`).
- A validation error's `message` is a JSON string and its `value` is the submitted
  body, which can hold passwords. The issues list replaces both.

## Step 5 — Level
Add a level file next to the request event file (propose the path if the Layout
doesn't list one):

```ts
import { SLOW_MS } from '<constants path>'

export type Level = 'info' | 'warn' | 'error'

type LevelInput = {
  /** The status the client received. */
  status: number
  /** How long the request took. */
  durationMs: number
  /** An error was recorded with log.capture() and the request carried on. */
  handledError: boolean
}

/**
 * How did this request go?
 * - error: it didn't do what was asked (any 4xx or 5xx)
 * - warn:  it worked, but not cleanly (an error was handled, or it was slow)
 * - info:  it worked cleanly
 */
export function levelFor({ status, durationMs, handledError }: LevelInput): Level {
  if (status >= 400) return 'error'
  if (handledError) return 'warn'
  if (durationMs >= SLOW_MS) return 'warn'
  return 'info'
}
```

And its test, next to it, following the codebase's test naming:

```ts
import { expect, test } from 'bun:test'
import { SLOW_MS } from '<constants path>'
import { levelFor } from '<level path>'

const cases = [
  { status: 200, durationMs: 5, handledError: false, expected: 'info', why: 'clean success' },
  { status: 302, durationMs: 5, handledError: false, expected: 'info', why: 'redirect' },
  { status: 200, durationMs: SLOW_MS, handledError: false, expected: 'warn', why: 'slow (at threshold)' },
  { status: 200, durationMs: 5, handledError: true, expected: 'warn', why: 'handled error' },
  { status: 404, durationMs: 5, handledError: false, expected: 'error', why: 'not found' },
  { status: 422, durationMs: 5, handledError: false, expected: 'error', why: 'validation' },
  { status: 402, durationMs: SLOW_MS * 2, handledError: true, expected: 'error', why: 'failure wins over slow and handled' },
  { status: 500, durationMs: 5, handledError: false, expected: 'error', why: 'server error' },
] as const

for (const { expected, why, ...input } of cases) {
  test(`${input.status} ${why} → ${expected}`, () => expect(levelFor(input)).toBe(expected))
}
```

## Step 6 — Use them in the request event
The request event file after this phase, in full. Compared with before, it imports
`errorFields` and `levelFor`, has a `handled` flag and a `capture` method, picks the
level in `write`, and passes Elysia's error `code` to `errorFields` in `onError`:

```ts
import { Elysia } from 'elysia'
import { REQUEST_ID_HEADER } from '<constants path>'
import { errorFields } from '<errors path>'
import { levelFor } from '<level path>'
import { logger } from '<logger path>'
import { requestId } from '<request id path>'

type Fields = Record<string, unknown>

function createLog(request: Request, id: string) {
  const start = performance.now()
  const fields: Fields = {}
  let written = false
  let handled = false

  return {
    fields,
    /** Add to an entity on this request's line; a second add merges into it. */
    add(entity: string, data: Fields) {
      const existing = fields[entity]
      fields[entity] = existing && typeof existing === 'object' ? { ...existing, ...data } : data
    },
    /** Record an error you handled; the request can still succeed. */
    capture(error: unknown) {
      fields.error = errorFields(error)
      handled = true
    },
    /** Write the line once. Called by the plugin only. */
    write(status: number, route?: string) {
      if (written) return
      written = true
      try {
        const duration_ms = Math.round(performance.now() - start)
        const level = levelFor({ status, durationMs: duration_ms, handledError: handled })
        logger[level]({
          ...fields,
          request_id: id,
          method: request.method,
          path: new URL(request.url).pathname,
          request: route ? { route } : undefined,
          status_code: status,
          duration_ms,
        })
      } catch {
        // A logging failure must never affect the response or the process.
      }
    },
  }
}

export type Log = Pick<ReturnType<typeof createLog>, 'add' | 'capture'>

export const logging = new Elysia({ name: 'logging' })
  .use(requestId)
  .derive({ as: 'global' }, ({ request, requestId }) => ({ log: createLog(request, requestId) }))
  .macro({
    flow: (name: string) => ({
      transform({ log }) {
        log.fields.flow = name
      },
    }),
  })
  .onError({ as: 'global' }, (ctx) => {
    const { error, code, request, set } = ctx
    if ('log' in ctx) {
      (ctx.log as ReturnType<typeof createLog>).fields.error = errorFields(error, String(code))
      return
    }
    // derive never ran (unmatched route, unparsable body): write the line here
    const fallback = createLog(request, String(set.headers[REQUEST_ID_HEADER]))
    fallback.fields.error = errorFields(error, String(code))
    fallback.write(error && typeof error === 'object' && 'status' in error ? Number(error.status) : Number(set.status ?? 500))
  })
  .onAfterResponse({ as: 'global' }, ({ log, set, route }) => {
    log?.write(Number(set.status ?? 200), route)
  })
```

Keep what earlier phases chose:
- the `flow` macro only if the flow phase chose the route option;
- `client_request_id` (read in `createLog`, written next to `request_id`) if the
  request id phase chose option 3.

Edit the existing file to match; don't replace code the user added since.
The file is about 75 lines. That is expected: do not split it unless the user asks.

## Step 7 — Use it in app code
**Domain errors explain themselves.** Error classes carry what a reader needs:

```ts
export class PaymentError extends Error {
  name = 'PaymentError'
  status = 402 // only with "give error classes a status"; Elysia uses it as the response status
  constructor(message: string, public details: Record<string, unknown>) {
    super(message)
  }
}

throw new PaymentError('payment declined', { provider: 'paystack', reason: 'insufficient_funds' })
```

**Wrap with `cause`** when rethrowing, so the original reason stays on the line:
`throw new Error('order insert failed', { cause: error })`.

**Handled errors** use `log.capture`:

```ts
try {
  await cache.set(key, value)
} catch (error) {
  log.capture(error)   // the request carries on; the line still shows what failed
}
```

Existing project: for each `catch` from Step 1 that logs and carries on, replace the
log call with `log.capture(error)`. Leave `catch` blocks that rethrow as they are.
Existing error classes: add `details` only where the user agrees.

## Done when
Show one line each for: a success, a slow success, a validation failure, an
unparsable body, an unknown route, a thrown error with a `cause`, a domain error
with `details`, and a handled error on a successful request. For example:

`{"level":"error","flow":"sign_up","status_code":422,"error":{"name":"ValidationError","message":"invalid body","code":"VALIDATION","details":{"on":"body","issues":[{"path":"/email","summary":"Property 'email' should be email"}]}},…}`

- The level test passes, and each line's level matches the table in the Goal.
- A domain error's `status_code` matches the selected status choice.
- No submitted value (such as a password) appears in any validation error.
Stop. Show the diff and the lines.
