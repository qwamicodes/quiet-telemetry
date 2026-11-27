# quiet · Elysia · Flow names and outgoing ids

Follow the style rules and run order in `SKILL.md`. Tested on Elysia 1.4.32, Bun 1.4
and pino 10.

## Goal
Every route's line carries a `flow`: a short, stable business name such as
`create_order`. quiet uses it to label rows in the stream. It is not an id.
When this service calls another service of ours, it sends its `request_id` so both
lines share one id. Third-party APIs never receive it.

Not in this phase: business breadcrumbs, levels and error shape, headers,
redaction, sampling, jobs.

## Step 1 — Name the flows
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

## Step 2 — Where flow is set
Ask the user to select one:

1. **Route option**: `{ flow: 'create_order' }` next to `body` and `params`.
   It is set before validation, so 422s and errors still carry the flow.
2. **In the handler**: `log.fields.flow = 'create_order'` as the first line.
   Validation failures (422) have no flow, because the handler never runs.

Stop.

## Step 3 — Add the flows
Option 1: add this macro to the request event plugin, after its `derive`:

```ts
  .macro({
    flow: (name: string) => ({
      transform({ log }) {
        log.fields.flow = name
      },
    }),
  })
```

Then on each route:

```ts
.post('/orders', ({ body, log }) => {
  log.add('order', { item_count: body.items.length })
  …
}, { flow: 'create_order', body: t.Object({ items: t.Array(t.String()) }) })
```

Option 2: set `log.fields.flow` as the first line of each handler.

Use the reviewed names exactly. Add a **Flows** section to `docs/logging.md`
listing them (method, route, flow), and keep it in sync when routes change.

## Step 4 — Outgoing calls
List every outgoing HTTP call (file:line): `fetch`, Eden Treaty, ky, axios or
any shared API client. For each, say whether it goes to **one of our services**
or a **third party** (payments, email, SMS…).
Stop. The user confirms the list.

For calls to our own services only, send the id in the header:

```ts
.post('/orders', async ({ log, requestId }) => {
  const stock = await fetch(`${INVENTORY_URL}/stock`, {
    headers: { [REQUEST_ID_HEADER]: requestId },
  }).then((r) => r.json())
  log.add('inventory', { in_stock: stock.inStock })
  …
}, { flow: 'create_order' })
```

- If calls to that service already go through one shared client function, add
  the header there once, with `requestId` as a parameter. Do not wrap `fetch`.
- With Eden Treaty, pass the header in the call's `headers` option (not yet tested: verify).
- Never send the id to third parties.
- The receiving service must use the request id phase's option 2 (accept client id)
  to keep it. If it uses option 1 or 3, say so.
- Record what came back with `log.add` (`log.add('inventory', { in_stock })`),
  not as a list of calls.

## Done when
- Every route in the Flows section prints its flow on success, on a thrown error
  and (option 1) on a validation failure. Show one of each.
- One call to our own service shows the same `request_id` in both services' lines,
  or this is reported as "no calls between our services".
- No third-party call sends `x-request-id`.
Stop. Show the diff and the lines.
