# quiet logging — Elysia (Bun) binding

Tested on Elysia 1.4.32, Bun 1.4 and pino 10. Read `../SKILL.md` first: it holds the
run order and the style rules every phase follows.

## Phase 0 — Layout, logger and constants

### Step 1 — Map the codebase
Report each row with one real file path as evidence:

| | Finding | Evidence |
|---|---|---|
| Single app or monorepo (which apps are Elysia backends) | | |
| Where shared plugins/utils live (`src/plugins`, `src/utils`, `packages/*`…) | | |
| Where env/config is read | | |
| File naming and import aliases | | |
| Entry file where plugins are `.use()`d | | |
| Existing logger or logging plugin | | |
| Background jobs: queue, scheduler or cron (package, where workers run) | | |

Then propose a path for: logger, constants, request id plugin, request event plugin.
If the codebase has no structure yet, start from Elysia's feature layout
(`src/modules/<feature>/`) and offer places for shared plugins as options.
Where more than one path fits, give a numbered list and ask the user to select.

If the map found no background jobs, ask the user:
"Does this project run background jobs or scheduled tasks?"
- **No**: jobs are skipped in every later phase.
- **Not yet, but planned**: record it; the jobs phase will offer options then.
- **Yes**: ask where they live, since the map missed them, and add them to the map.
Do not install anything for jobs in this phase.
Stop.

### Step 2 — Choose a logger
Ask the user to select one:

1. **pino**: already emits quiet's line shape and has built-in redaction; one dependency.
2. **LogTape**: zero dependencies, official Elysia adapter; needs a custom formatter
   (its JSON output nests fields under `properties`).
3. **No library**: `JSON.stringify` to stdout; you build levels and redaction later.

If the project already has a logger, list it as option 0 with what it would need to
match quiet's shape. Do not use access-log plugins (logixlysia, `@bogeychan/elysia-logger`)
as the canonical event; they write their own per-request line.
Stop.

### Step 3 — Set up
In the agreed constants file:

```ts
export const SERVICE = Bun.env.SERVICE_NAME ?? '<package.json name>'
export const ENV = Bun.env.NODE_ENV ?? 'development'
export const VERSION = Bun.env.SERVICE_VERSION
export const COMMIT_SHA = Bun.env.COMMIT_SHA

export const REQUEST_ID_HEADER = 'x-request-id'
export const SLOW_MS = 2000
export const SAMPLE_RATE = 1
export const REQUEST_HEADERS = ['content-type', 'user-agent']
export const REDACT_KEYS = ['authorization', 'cookie', 'password', 'token', 'api_key', 'secret']
```

If the codebase already reads env through one module, read these values through it.

In the agreed logger file, with pino:

```ts
import pino from 'pino'
import { COMMIT_SHA, ENV, SERVICE, VERSION } from '<constants path>'

export const logger = pino({
  base: { service: SERVICE, env: ENV, version: VERSION, commit_sha: COMMIT_SHA },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: { level: (label) => ({ level: label }) },
})
```

For another choice, match the same output: top-level fields, a `timestamp` key and a lowercase `level`.

Existing project: move logging magic values into the constants file and change only
the logger's config. Leave existing log calls as they are.

### Step 4 — Record the layout
Create `docs/logging.md` with:
- **Layout**: the agreed paths, the chosen logger, the constants file, and the jobs
  answer (the job system in use, "planned" or "none"). Later phases read this first.
- **Progress**: an empty list; the skill appends to it.

### Done when
The app starts and prints one boot line like:
`{"level":"info","timestamp":"…","service":"api","env":"development","version":"1.0.0","flow":"boot"}`
Stop. Show the diff and the boot line.

## Phase 1 — Request id and request event

### Goal
Every request gets one id and produces exactly one event, including errors and 404s.
Handlers add business fields to the event; the plugin writes it once when the response
is sent. Writing it must never change the response or crash the process.

Not in this phase: flow naming and passing ids on (2), levels and error shape (3),
headers and redaction (4), sampling (5), jobs (6). Log everything at `info`.

### Step 1 — Look first
List (file:line): any existing request-id plugin, access-log plugins, per-route
"request started/finished" logs, and anything that reads or sets `x-request-id`.
If a request-id plugin already exists and does what Step 2 does, keep it and make
the request event read the id from the response header it sets.
Stop.

### Step 2 — Request id
Ask the user to select one:

1. **Server only**: every request gets a new id. Client-sent ids are ignored.
2. **Accept client id**: use the client's `x-request-id` if it is valid, otherwise
   generate one. Client and server logs share one id.
3. **Keep both**: always generate the server id, and log a valid client id separately
   as `client_request_id`. Clients can't reuse another request's id.

Stop. Write only the selected option.

Add to the constants file (options 2 and 3 only):

```ts
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/ // blocks oversized or unsafe ids
```

Request id plugin:

```ts
import { Elysia } from 'elysia'
import { REQUEST_ID_HEADER, REQUEST_ID_PATTERN } from '<constants path>'

// Options 2 and 3 only
export const clientRequestId = (request: Request) => {
  const id = request.headers.get(REQUEST_ID_HEADER)
  return id && REQUEST_ID_PATTERN.test(id) ? id : undefined
}

export const requestId = new Elysia({ name: 'request-id' })
  .onRequest(({ request, set }) => {
    set.headers[REQUEST_ID_HEADER] = crypto.randomUUID()                            // options 1 and 3
    // set.headers[REQUEST_ID_HEADER] = clientRequestId(request) ?? crypto.randomUUID() // option 2
  })
  .derive({ as: 'global' }, ({ set }) => ({
    requestId: set.headers[REQUEST_ID_HEADER] as string,
  }))
```

Option 3 only: in the request event, add `client_request_id: clientRequestId(request)`
next to `request_id`.

### Step 3 — Request event
The event starts in `onRequest` because `derive` does not run for 404s.
The plugin's own fields come last so handlers can't overwrite them.

```ts
import { Elysia } from 'elysia'
import { REQUEST_ID_HEADER } from '<constants path>'
import { logger } from '<logger path>'
import { requestId } from '<request id path>'

export type WideEvent = Record<string, unknown>

const events = new WeakMap<Request, { event: WideEvent; start: number }>()

export const wideEvent = new Elysia({ name: 'wide-event' })
  .use(requestId)
  .onRequest(({ request }) => {
    events.set(request, { event: {}, start: performance.now() })
  })
  .derive({ as: 'global' }, ({ request }) => ({
    wideEvent: events.get(request)!.event,
  }))
  .onError({ as: 'global' }, ({ request, error }) => {
    const entry = events.get(request)
    if (entry) entry.event.error = error instanceof Error ? { name: error.name, message: error.message } : error
  })
  .onAfterResponse({ as: 'global' }, ({ request, set, route }) => {
    const entry = events.get(request)
    if (!entry) return
    try {
      logger.info({
        ...entry.event,
        request_id: set.headers[REQUEST_ID_HEADER],
        method: request.method,
        path: new URL(request.url).pathname,
        request: route ? { route } : undefined,
        status_code: set.status,
        duration_ms: Math.round(performance.now() - entry.start),
      })
    } catch {
      // A logging failure must never affect the response or the process.
    }
  })
```

If the chosen logger isn't pino, change only the `logger.info(...)` call.
`.use(wideEvent)` once in the entry file; it brings `requestId` with it. Sub-apps may
also `.use(wideEvent)` for typing; the plugin name keeps it to one event.
Do not wrap `fetch`, clone responses or read bodies.

### Step 4 — Use it
Handlers set fields directly, no helpers and no `null`s:

```ts
.get('/:id', ({ wideEvent, params }) => {
  wideEvent.order = { id: params.id }
  …
})
```

New project: enrich one route as the example.
Existing project: remove only the access-log lines from Step 1 that this replaces,
and move their fields onto `wideEvent` in those handlers. Keep all other logs.

### Done when
- A 200, a thrown error and a 404 each print one line with `request_id`, and the
  response's `x-request-id` header matches it.
- Send a request with `x-request-id: web-abc123` and one with `x-request-id: bad id`.
  Both lines follow the selected option.
- No query string in `path`.
- Note any streaming routes (`duration_ms` only covers until the stream starts).
Stop. Show the diff and the lines.

## Phase 2 — Flow names and outgoing ids

### Goal
Every route's event carries a `flow`: a short, stable business name such as
`create_order`. quiet uses it to label rows in the stream. It is not an id.
When this service calls another service of ours, it sends its `request_id` so both
events share one id. Third-party APIs never receive it.

Not in this phase: levels and error shape (3), headers and redaction (4),
sampling (5), jobs (6).

### Step 1 — Name the flows
List every route and propose a flow name:

| Method | Route | Proposed flow | Notes |
|---|---|---|---|
| POST | /orders | create_order | |

Naming rules:
- `snake_case`, written as `<verb>_<noun>`: `create_order`, `list_orders`,
  `refund_payment`, `sign_in`.
- Business language, not URL language: `sign_in`, not `post_auth_login`.
- One flow per route. The same operation keeps the same name across API versions.
- Health checks, docs and static routes get no flow unless the user asks.
- If a handler already sets a flow-like name (a log message or span name), reuse it.

Existing project: flag routes where you are unsure what the operation is.
Stop. The user reviews and edits the names.

### Step 2 — Where flow is set
Ask the user to select one:

1. **Route option**: `{ flow: 'create_order' }` next to `body` and `params`.
   It is set before validation, so 422s and errors still carry the flow.
2. **In the handler**: `wideEvent.flow = 'create_order'` as the first line.
   Validation failures (422) have no flow, because the handler never runs.

Stop.

### Step 3 — Add the flows
Option 1: add this macro to the request event plugin, after its `derive`:

```ts
  .macro({
    flow: (name: string) => ({
      transform({ wideEvent }) {
        wideEvent.flow = name
      },
    }),
  })
```

Then on each route:

```ts
.post('/orders', ({ body, wideEvent }) => {
  wideEvent.order = { item: body.item }
  …
}, { flow: 'create_order', body: t.Object({ item: t.String() }) })
```

Option 2: set `wideEvent.flow` as the first line of each handler.

Use the reviewed names exactly. Add a **Flows** section to `docs/logging.md`
listing them (method, route, flow), and keep it in sync when routes change.

### Step 4 — Outgoing calls
List every outgoing HTTP call (file:line): `fetch`, Eden Treaty, ky, axios or
any shared API client. For each, say whether it goes to **one of our services**
or a **third party** (payments, email, SMS…).
Stop. The user confirms the list.

For calls to our own services only, send the id in the header:

```ts
.post('/orders', async ({ wideEvent, requestId }) => {
  const stock = await fetch(`${INVENTORY_URL}/stock`, {
    headers: { [REQUEST_ID_HEADER]: requestId },
  }).then((r) => r.json())
  wideEvent.inventory = { in_stock: stock.inStock }
  …
}, { flow: 'create_order' })
```

- If calls to that service already go through one shared client function, add
  the header there once, with `requestId` as a parameter. Do not wrap `fetch`.
- With Eden Treaty, pass the header in the call's `headers` option (not yet tested: verify).
- Never send the id to third parties.
- The receiving service must use Phase 1 option 2 (accept client id) to keep it.
  If it uses option 1 or 3, say so.
- Record what came back as business fields (`wideEvent.payment = { provider, status }`),
  not as a list of calls.

### Done when
- Every route in the Flows section prints its flow on success, on a thrown error
  and (option 1) on a validation failure. Show one of each.
- One call to our own service shows the same `request_id` in both services' lines,
  or this is reported as "no calls between our services".
- No third-party call sends `x-request-id`.
Stop. Show the diff and the lines.

## Phase 6 — Jobs and cron

### Step 1 — Jobs in this project
Read the jobs answer in the Layout section of `docs/logging.md`.

- **A job system is in use**: use it. Do not suggest switching.
- **"none"**: stop here and tell the user this phase is skipped.
- **"planned"**: ask the user to select one, then stop:

  Queues (work triggered by requests, with retries):
  1. **BullMQ**: Redis-backed, the most widely used; supports Bun's native Redis client.
  2. **pg-boss**: Postgres-backed, no Redis needed; supports Bun.
  3. **bunqueue**: SQLite-backed, no external service, BullMQ-like API; newer.

  Schedules only (no queue):
  4. **Bun.cron**: built into Bun, in-process or OS-level.
  5. **@elysiajs/cron**: Elysia plugin, schedules declared on the app.
     Check which package name is current (`@elysiajs/cron` or `@elysia/cron`).

  Installing the selected system is the user's call: confirm before adding it.
  Record the choice in the Layout section.

If the Layout has no jobs answer (Phase 0 ran before this step existed), ask the
Phase 0 jobs question first.

The rest of Phase 6 is not written yet: stop after Step 1.
