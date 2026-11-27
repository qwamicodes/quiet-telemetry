# quiet · Elysia · Levels and error shape

Follow the style rules and run order in `SKILL.md`. Tested on Elysia 1.4.32, Bun 1.4
and pino 10.

## Goal
Each line's `level` says how bad it was, and its `error` says what broke and why,
in plain fields: the error's real type, a readable message, its details and its
cause. A validation failure lists what was wrong without repeating what was sent.

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

**Client errors (4xx)**
1. `error`: every failed request is an error.
2. `warn`: 4xx is `warn`, only 5xx is `error`.

**Handled errors** (recorded with `log.capture`, request still succeeds)
1. `error`
2. `warn`

**Stack traces**
1. Never.
2. Outside production only.
3. Always.

**Domain error statuses** (a thrown domain error returns 500 unless its class says otherwise)
1. Leave them as they are.
2. Give error classes a `status` (such as 402 for a declined payment). This changes
   what the API returns, so confirm each class with the user.

Stop. The level and stack choices become constants in Step 3.

Whatever is chosen: a 5xx is always `error`, a success at or over `SLOW_MS` is `warn`,
any other success is `info`.

## Step 3 — Constants
Add to the constants file, with the selected values:

```ts
export const CLIENT_ERROR_LEVEL: 'error' | 'warn' = 'error'   // 4xx
export const HANDLED_ERROR_LEVEL: 'error' | 'warn' = 'error'  // log.capture() on a successful request
export const LOG_STACK = ENV !== 'production'                 // never: false, always: true
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

## Step 5 — Levels and `log.capture` in the request event
In the request event file:

1. Import `errorFields` and the level constants.
2. Add a `handled` flag and a `capture` method next to `add`:

   ```ts
   let handled = false
   …
   /** Record an error you handled; the request can still succeed. */
   capture(error: unknown) {
     fields.error = errorFields(error)
     handled = true
   },
   ```

3. In `write`, pick the level and call the logger with it:

   ```ts
   const duration_ms = Math.round(performance.now() - start)
   const level =
     status >= 500 ? 'error'
     : status >= 400 ? CLIENT_ERROR_LEVEL
     : fields.error ? (handled ? HANDLED_ERROR_LEVEL : 'error')
     : duration_ms >= SLOW_MS ? 'warn'
     : 'info'
   logger[level]({ …same fields as before…, duration_ms })
   ```

4. Export `capture` to app code: `export type Log = Pick<ReturnType<typeof createLog>, 'add' | 'capture'>`.
5. In `onError`, use `errorFields(error, String(code))` in both places, taking `code`
   from the hook's context.

The request event file grows to about 80 lines with these changes. That is expected
for this file: do not split it unless the user asks.

## Step 6 — Use it in app code
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

- Levels follow the selected rules.
- A domain error's `status_code` matches the selected status choice.
- No submitted value (such as a password) appears in any validation error.
Stop. Show the diff and the lines.
