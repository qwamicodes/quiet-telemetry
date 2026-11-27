# quiet · Elysia · Headers and redaction

Follow the style rules and run order in `SKILL.md`. Tested on Elysia 1.4.32, Bun 1.4
and pino 10.

## Goal
The line says who sent the request, so it can be traced back to a client: the user
agent, the client's IP, a device id, the app version, whichever the user chooses. And
no secret ever reaches the line, wherever it was added: `log.add` data, error details
or headers.

- **Headers are allow-listed.** Only the headers you name are logged.
- **Redaction runs on the whole line**, just before it is written. Any key whose words
  match `REDACT_KEYS` becomes `"[REDACTED]"`, at any depth.
- quiet also redacts credentials when it receives a line. That is a second line of
  defence, not a reason to skip this one.

Not in this phase: sampling, jobs, request/response bodies.

## Step 1 — Look first
List:
- request headers the app relies on (user agent, app version, device id, tenant…)
  and where they are read (file:line);
- what sits in front of the app (Traefik, Nginx, Cloudflare, a load balancer) and which
  header carries the client's IP there;
- any redaction already configured (pino `redact`, custom scrubbers).
Stop.

## Step 2 — Choose
Ask the user to select or confirm each. These decide what a line can tell you about
who sent the request.

**Headers to log**: propose an allow-list from Step 1. Start from `content-type` and
`user-agent`, and add the client headers the app receives, such as a device id
(`x-device-id`), app version (`x-app-version`) or platform. Never propose
`authorization` or `cookie`.

**Client IP** (personal data)
1. Don't log it.
2. The connection's address (`socket`): only when nothing sits in front of the app.
   Behind a proxy (Traefik with Dokploy or Coolify, Nginx, Cloudflare, a load
   balancer) this is the proxy's address, not the client's.
3. From a proxy header (`proxy`): name the header the proxy sets, such as
   `x-forwarded-for` (Traefik, Nginx), `cf-connecting-ip` (Cloudflare) or `x-real-ip`.
   Only correct behind a proxy that sets it.

If Step 1 found a proxy in front of the app, tell the user that option 2 would log the
proxy's address, and which header that proxy sets for option 3.

Stop.

Redact keys are not a choice: this phase sets the standard credentials in Step 3. The
app's own secret names (a PIN, an OTP, a national id number…) are the user's to add to
`REDACT_KEYS` later; do not search the codebase for them.

## Step 3 — Constants
Update the constants file with the selected values (`REQUEST_HEADERS` and
`REDACT_KEYS` are already there from the layout phase):

```ts
export const REQUEST_HEADERS = ['content-type', 'user-agent']
// Standard credentials. Add the app's own secret names (pin, otp, national id…) here.
export const REDACT_KEYS = [
  'authorization', 'cookie', 'password', 'passwd', 'token', 'api_key', 'secret',
  'private_key', 'credential', 'credentials', 'card_number', 'cvv',
]
export const CLIENT_IP: 'none' | 'socket' | 'proxy' = 'none'
export const CLIENT_IP_HEADER = 'x-forwarded-for' // used only with 'proxy'
```

## Step 4 — Redaction
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

## Step 5 — Request context
The request context file after this phase, in full. `readRequest` now also reads the
allow-listed headers and takes the client IP, and the two helpers below it are new:

```ts
import { CLIENT_IP, CLIENT_IP_HEADER, REQUEST_HEADERS } from '<constants path>'

type Fields = Record<string, unknown>
export type Arrival = { route?: string; params?: Fields; ip?: string }

/** What came in, read the moment the request arrives. */
export function readRequest(request: Request, { route, params, ip }: Arrival) {
  const url = new URL(request.url)
  const query = Object.fromEntries(url.searchParams)
  return {
    method: request.method,
    path: url.pathname,
    request: {
      route,
      params: params && Object.keys(params).length ? params : undefined,
      query: Object.keys(query).length ? query : undefined,
      headers: pickHeaders(request.headers),
      ip,
    },
  }
}

/** Only the allow-listed request headers, lowercase names. */
export function pickHeaders(headers: Headers): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const name of REQUEST_HEADERS) {
    const value = headers.get(name)
    if (value !== null) picked[name] = value
  }
  return picked
}

/** The client's IP, per the CLIENT_IP choice. */
export function clientIp(request: Request, socketIp?: string): string | undefined {
  if (CLIENT_IP === 'socket') return socketIp
  if (CLIENT_IP === 'proxy') return request.headers.get(CLIENT_IP_HEADER)?.split(',')[0]?.trim() || undefined
  return undefined
}
```

## Step 6 — The request event
The request event file after this phase, in full. Compared with before, it takes the
client IP in `derive` (and in `onError` for lines it writes itself), passes it to
`readRequest`, and redacts the whole line before writing it:

```ts
import { Elysia } from 'elysia'
import { REQUEST_ID_HEADER } from '<constants path>'
import { errorFields } from '<errors path>'
import { levelFor } from '<level path>'
import { redact } from '<redact path>'
import { logger } from '<logger path>'
import { requestId } from '<request id path>'
import { clientIp, readRequest, type Arrival } from '<request context path>'

type Fields = Record<string, unknown>

function createLog(request: Request, id: string, arrival: Arrival = {}) {
  const start = performance.now()
  const incoming = readRequest(request, arrival) // now, not at write: Bun may release the request after the response
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
        logger[level](redact({
          ...fields,
          request_id: id,
          ...incoming,
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
  .derive({ as: 'global' }, ({ request, requestId, server, route, params }) => ({
    log: createLog(request, requestId, { route, params, ip: clientIp(request, server?.requestIP(request)?.address) }),
  }))
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
    const fallback = createLog(request, String(set.headers[REQUEST_ID_HEADER]), {
      ip: clientIp(request, ctx.server?.requestIP(request)?.address),
    })
    fallback.fields.error = errorFields(error, String(code))
    fallback.write(error && typeof error === 'object' && 'status' in error ? Number(error.status) : Number(set.status ?? 500))
  })
  .onAfterResponse({ as: 'global' }, ({ log, set }) => {
    log?.write(Number(set.status ?? 200))
  })
```

Headers are read in `readRequest`, at arrival, for the same reason as the rest of the
request: `write` runs after the response is sent, and in testing every header was gone
by then unless something had read them earlier.

Keep what earlier phases chose (the `flow` macro, `client_request_id`). Edit the
existing file to match; don't replace code the user added since.

Existing project: keep any existing logger redaction as well; this one covers the
whole line regardless of logger.

## Done when
- The redaction test passes.
- A line shows the chosen client details: the allow-listed headers under
  `request.headers` and, if chosen, the client's IP under `request.ip`. A 404 line
  shows them too.
- The IP appears only if chosen, from the chosen source.
- Show one line where `log.add` data, error `details` and an allow-listed header all
  hold a secret-like key: every one shows `"[REDACTED]"`.
Stop. Show the diff and the lines.
