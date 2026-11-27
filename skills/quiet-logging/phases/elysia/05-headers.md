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
// Allow-listed request headers. Add any custom headers your clients send (x-device-id, x-app-version…).
export const REQUEST_HEADERS = ['content-type', 'user-agent']
export const CLIENT_IP: 'none' | 'socket' | 'proxy' = 'none'
export const CLIENT_IP_HEADER = 'x-forwarded-for' // used only with 'proxy'
```

`REQUEST_HEADERS` can grow at any time: when a client starts sending a new custom
header worth tracing, adding its name here is all it takes.

## Step 4 — Request context
The request context plugin after this phase, in full. `readRequest` now also reads the
allow-listed headers and the client's IP, and the two helpers below it are new. Every
handler and service gets them through `client` (`client.headers['x-device-id']`,
`client.ip`), and so does the line:

```ts
import { Elysia } from 'elysia'
import { CLIENT_IP, CLIENT_IP_HEADER, REQUEST_HEADERS } from '<constants path>'

type Fields = Record<string, unknown>
type Arrival = { route?: string; params?: Fields; socketIp?: string }

/** Everything about the incoming request, read the moment it arrives. */
export function readRequest(request: Request, { route, params, socketIp }: Arrival = {}) {
  const url = new URL(request.url)
  const query = Object.fromEntries(url.searchParams)
  return {
    method: request.method,
    path: url.pathname,
    route,
    params: params && Object.keys(params).length ? params : undefined,
    query: Object.keys(query).length ? query : undefined,
    headers: pickHeaders(request.headers),
    ip: clientIp(request, socketIp),
  }
}

export type Client = ReturnType<typeof readRequest>

/** Makes `client` available to every handler, service and the logger. */
export const requestContext = new Elysia({ name: 'request-context' })
  .derive({ as: 'global' }, ({ request, route, params, server }) => ({
    client: readRequest(request, { route, params, socketIp: server?.requestIP(request)?.address }),
  }))

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
The request event plugin does not change in this phase: it already builds the line
from `client`. Keep what earlier phases chose.

## Done when
- A line shows the chosen client details: the allow-listed headers under
  `request.headers` and, if chosen, the client's IP under `request.ip`. A 404 line
  shows them too.
- The IP appears only if chosen, from the chosen source.
- A handler can read the same details from `client`.
- No header outside the allow-list appears on any line.
Stop. Show the diff and the lines.
