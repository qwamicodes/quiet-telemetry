# quiet · Elysia · Headers

Follow the style rules and run order in `SKILL.md`. Tested on Elysia 1.4.32, Bun 1.4
and pino 10.

## Goal
The line says who sent the request, so it can be traced back to a client: the user
agent, the client's IP, a device id, the app version, whichever the user chooses.
Only the headers the user names are logged (an allow-list), read when the request
arrives.

Not in this phase: redaction, sampling, jobs, request/response bodies.

## Step 1 — Look first
List:
- request headers the app relies on (user agent, app version, device id, tenant…)
  and where they are read (file:line);
- what sits in front of the app (Traefik, Nginx, Cloudflare, a load balancer) and which
  header carries the client's IP there.
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

## Step 3 — Constants
Update the constants file with the selected values (`REQUEST_HEADERS` is already there
from the layout phase):

```ts
export const REQUEST_HEADERS = ['content-type', 'user-agent']
export const CLIENT_IP: 'none' | 'socket' | 'proxy' = 'none'
export const CLIENT_IP_HEADER = 'x-forwarded-for' // used only with 'proxy'
```

## Step 4 — Request context
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

## Step 5 — The request event
The request event file after this phase, in full. Compared with before, it takes the
client IP in `derive` (and in `onError` for lines it writes itself) and passes it to
`readRequest`:

```ts
import { Elysia } from 'elysia'
import { REQUEST_ID_HEADER } from '<constants path>'
import { errorFields } from '<errors path>'
import { levelFor } from '<level path>'
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
        logger[level]({
          ...fields,
          request_id: id,
          ...incoming,
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

## Done when
- A line shows the chosen client details: the allow-listed headers under
  `request.headers` and, if chosen, the client's IP under `request.ip`. A 404 line
  shows them too.
- The IP appears only if chosen, from the chosen source.
- No header outside the allow-list appears on any line.
Stop. Show the diff and the lines.
