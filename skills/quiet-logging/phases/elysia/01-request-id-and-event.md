# quiet · Elysia · Request id and request event

Follow the style rules and run order in `SKILL.md`. Tested on Elysia 1.4.32, Bun 1.4
and pino 10.

## Goal
Every request gets one id and produces exactly one event, including errors and 404s.
Handlers add business fields to the event; the plugin writes it once when the response
is sent. Writing it must never change the response or crash the process.

Not in this phase: flow names and outgoing ids, business breadcrumbs, levels and
error shape, headers and redaction, sampling, jobs. Log everything at `info`.

## Step 1 — Look first
List (file:line): any existing request-id plugin, access-log plugins, per-route
"request started/finished" logs, and anything that reads or sets `x-request-id`.
If a request-id plugin already exists and does what Step 2 does, keep it and make
the request event read the id from the response header it sets.
Stop.

## Step 2 — Request id
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

## Step 3 — Request event
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

## Step 4 — Use it
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

## Done when
- A 200, a thrown error and a 404 each print one line with `request_id`, and the
  response's `x-request-id` header matches it.
- Send a request with `x-request-id: web-abc123` and one with `x-request-id: bad id`.
  Both lines follow the selected option.
- No query string in `path`.
- Note any streaming routes (`duration_ms` only covers until the stream starts).
Stop. Show the diff and the lines.
