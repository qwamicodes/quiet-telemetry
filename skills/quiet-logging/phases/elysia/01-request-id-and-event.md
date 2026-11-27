# quiet · Elysia · Request id and request event

Follow the style rules and run order in `SKILL.md`. Tested on Elysia 1.4.32, Bun 1.4
and pino 10.

## Goal
Every request gets one id and produces exactly one line, including errors, 404s and
unparsable bodies. App code adds to the line with `log.add`; the plugin writes it once
when the response is sent. Writing it must never change the response or crash the process.

Not in this phase: flow names and outgoing ids, business breadcrumbs, levels and
error shape, headers and redaction, sampling, jobs. Log everything at `info`.

## Step 1 — Look first
List (file:line): any existing request-id plugin, access-log plugins, per-route
"request started/finished" logs, and anything that reads or sets `x-request-id`.
If a request-id plugin already exists and does what Step 2 does, keep it and make
the request event read the id from it.
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
The plugin builds one `log` per request in `derive` and writes the line once in
`onAfterResponse`, when the final status is known. `derive` does not run for unmatched
routes or unparsable bodies, so `onError` writes those lines itself. The plugin's own
fields come last so app code can't overwrite them.

```ts
import { Elysia } from 'elysia'
import { REQUEST_ID_HEADER } from '<constants path>'
import { logger } from '<logger path>'
import { requestId } from '<request id path>'

type Fields = Record<string, unknown>

function createLog(request: Request, id: string) {
  const start = performance.now()
  const fields: Fields = {}
  let written = false

  return {
    fields,
    /** Add to an entity on this request's line; a second add merges into it. */
    add(entity: string, data: Fields) {
      const existing = fields[entity]
      fields[entity] = existing && typeof existing === 'object' ? { ...existing, ...data } : data
    },
    /** Write the line once. Called by the plugin only. */
    write(status: number, route?: string) {
      if (written) return
      written = true
      try {
        logger.info({
          ...fields,
          request_id: id,
          method: request.method,
          path: new URL(request.url).pathname,
          request: route ? { route } : undefined,
          status_code: status,
          duration_ms: Math.round(performance.now() - start),
        })
      } catch {
        // A logging failure must never affect the response or the process.
      }
    },
  }
}

export type Log = Pick<ReturnType<typeof createLog>, 'add'>

export const logging = new Elysia({ name: 'logging' })
  .use(requestId)
  .derive({ as: 'global' }, ({ request, requestId }) => ({ log: createLog(request, requestId) }))
  .onError({ as: 'global' }, (ctx) => {
    const { error, request, set } = ctx
    const errorField = error instanceof Error ? { name: error.name, message: error.message } : error
    if ('log' in ctx) {
      (ctx.log as ReturnType<typeof createLog>).fields.error = errorField
      return
    }
    // derive never ran (unmatched route, unparsable body): write the line here
    const fallback = createLog(request, String(set.headers[REQUEST_ID_HEADER]))
    fallback.fields.error = errorField
    fallback.write(error && typeof error === 'object' && 'status' in error ? Number(error.status) : Number(set.status ?? 500))
  })
  .onAfterResponse({ as: 'global' }, ({ log, set, route }) => {
    log?.write(Number(set.status ?? 200), route)
  })
```

If the chosen logger isn't pino, change only the `logger.info(...)` call.
`.use(logging)` once in the entry file; it brings `requestId` with it. Sub-apps may
also `.use(logging)` for typing; the plugin name keeps it to one line per request.
Do not wrap `fetch`, clone responses or read bodies.

## Step 4 — Use it
Controllers add to the line with `log.add(entity, data)`:

```ts
.get('/:id', ({ params, log }) => {
  log.add('order', { id: params.id })
  …
})
```

New project: add to one route as the example.
Existing project: remove only the access-log lines from Step 1 that this replaces,
and move their fields into `log.add` calls in those handlers. Keep all other logs.

## Done when
- A 200, a thrown error, a 404 and an unparsable JSON body each print exactly one line
  with `request_id` and the status the client got, and the response's `x-request-id`
  header matches it.
- Send a request with `x-request-id: web-abc123` and one with `x-request-id: bad id`.
  Both lines follow the selected option.
- No query string in `path`.
- Note any streaming routes (`duration_ms` only covers until the stream starts).
Stop. Show the diff and the lines.
