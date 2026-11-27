# quiet · Elysia · Redaction

Follow the style rules and run order in `SKILL.md`. Tested on Elysia 1.4.32, Bun 1.4
and pino 10.

## Goal
No secret ever reaches the line, wherever it was added: the request's query or
headers, `log.add` data, or error details. The request is read raw when it arrives
(and stays raw in `client` for app code); redaction runs once on the whole line, just
before it is written. Any key whose words
match `REDACT_KEYS` becomes `"[REDACTED]"`, at any depth.

quiet also redacts credentials when it receives a line. That is a second line of
defence, not a reason to skip this one.

Not in this phase: sampling, jobs, request/response bodies.

## Step 1 — Look first
List any redaction already configured (pino `redact`, custom scrubbers), file:line.
Stop.

Redact keys are not a choice: this phase sets the standard credentials in Step 2. The
app's own secret names (a PIN, an OTP, a national id number…) are the user's to add to
`REDACT_KEYS` later; do not search the codebase for them.

## Step 2 — Constants
Update `REDACT_KEYS` in the constants file (it is already there from the layout phase):

```ts
// Standard credentials. Add the app's own secret names (pin, otp, national id…) here.
export const REDACT_KEYS = [
  'authorization', 'cookie', 'password', 'passwd', 'token', 'api_key', 'secret',
  'private_key', 'credential', 'credentials', 'card_number', 'cvv',
]
```

## Step 3 — Redaction
Add a redact file next to the request event file (propose the path if the Layout
doesn't list one):

```ts
import { REDACT_KEYS } from '<constants path>'

/** Split a key into lowercase words: "accessToken" → access, token; "x-api-key" → x, api, key. */
const words = (key: string) =>
  key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

const secrets = REDACT_KEYS.map(words)

/** A key is secret when its words contain one of REDACT_KEYS as whole words, in order. */
function isSecret(key: string): boolean {
  const keyWords = words(key)
  return secrets.some((secret) =>
    keyWords.some((_, start) => secret.every((word, i) => keyWords[start + i] === word)),
  )
}

/** Copy a value with every secret key's value replaced by "[REDACTED]", at any depth. */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redact(item, seen))
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, isSecret(key) ? '[REDACTED]' : redact(item, seen)]),
  )
}
```

Keys match by whole words: `secret` redacts `client_secret` but not `secretary`, and
`token` redacts `refresh_token` (and also `token_count`). Its test, next to it:

```ts
import { expect, test } from 'bun:test'
import { redact } from '<redact path>'

const R = '[REDACTED]'

test('replaces secret keys at any depth', () => {
  expect(redact({ user: { id: 'u1', password: 'p', profile: { api_key: 'k', refresh_token: 't' } } })).toEqual({
    user: { id: 'u1', password: R, profile: { api_key: R, refresh_token: R } },
  })
})

test('matches key variants', () => {
  expect(redact({ accessToken: 'a', 'x-api-key': 'b', Authorization: 'c', client_secret: 'd', 'set-cookie': 'e' })).toEqual({
    accessToken: R, 'x-api-key': R, Authorization: R, client_secret: R, 'set-cookie': R,
  })
})

test('redacts inside arrays and leaves other values alone', () => {
  expect(redact({ list: [{ token: 't' }, { name: 'ok', count: 2 }] })).toEqual({ list: [{ token: R }, { name: 'ok', count: 2 }] })
})

test('survives circular objects', () => {
  const loop: Record<string, unknown> = { id: 'x' }
  loop.self = loop
  expect(redact(loop)).toEqual({ id: 'x', self: '[CIRCULAR]' })
})

test('matches whole words only', () => {
  expect(redact({ secretary: 'Ama', keyboard: 'qwerty', card_type: 'visa', secret_key: 's', card_number: 'n' })).toEqual({
    secretary: 'Ama', keyboard: 'qwerty', card_type: 'visa', secret_key: R, card_number: R,
  })
})
```

## Step 4 — The request event
The request event file after this phase, in full. Compared with before, it imports
`redact` and wraps the whole line in it before writing:

```ts
import { Elysia } from 'elysia'
import { REQUEST_ID_HEADER } from '<constants path>'
import { errorFields } from '<errors path>'
import { levelFor } from '<level path>'
import { redact } from '<redact path>'
import { logger } from '<logger path>'
import { requestId } from '<request id path>'
import { readRequest, requestContext, type Client } from '<request context path>'

type Fields = Record<string, unknown>

function createLog(id: string, client: Client) {
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
    write(status: number) {
      if (written) return
      written = true
      try {
        const duration_ms = Math.round(performance.now() - start)
        const level = levelFor({ status, durationMs: duration_ms, handledError: handled })
        const { method, path, ...request } = client
        logger[level](redact({
          ...fields,
          request_id: id,
          method,
          path,
          request,
          status_code: status,
          duration_ms,
        }))
      } catch {
        // A logging failure must never affect the response or the process.
      }
    },
  }
}

export type Log = Pick<ReturnType<typeof createLog>, 'add' | 'capture'>

export const logging = new Elysia({ name: 'logging' })
  .use(requestId)
  .use(requestContext)
  .derive({ as: 'global' }, ({ requestId, client }) => ({ log: createLog(requestId, client) }))
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
    // derive never ran (unmatched route, unparsable body): read the request and write the line here
    const client = readRequest(request, { socketIp: ctx.server?.requestIP(request)?.address })
    const fallback = createLog(String(set.headers[REQUEST_ID_HEADER]), client)
    fallback.fields.error = errorFields(error, String(code))
    fallback.write(error && typeof error === 'object' && 'status' in error ? Number(error.status) : Number(set.status ?? 500))
  })
  .onAfterResponse({ as: 'global' }, ({ log, set }) => {
    log?.write(Number(set.status ?? 200))
  })
```

Keep what earlier phases chose (the `flow` macro, `client_request_id`). Edit the
existing file to match; don't replace code the user added since.

Existing project: keep any existing logger redaction as well; this one covers the
whole line regardless of logger.

## Done when
- The redaction test passes.
- Show one line where the query, `log.add` data and error `details` all hold a
  secret-like key (such as `?token=…`, a `password`, a `secret_key`): every one shows
  `"[REDACTED]"`.
Stop. Show the diff and the lines.
