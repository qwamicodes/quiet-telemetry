# quiet · Elysia · Business breadcrumbs

Follow the style rules and run order in `SKILL.md`. Tested on Elysia 1.4.32, Bun 1.4
and pino 10; the handler and service code below is an example to adapt.

## Before you start
Also read the Flows section of `docs/logging.md`: this phase works through it.

## Goal
When something goes wrong, the line alone says what happened: who it was for, what
it was working on, which step it reached, what each step returned, and what failed.
Nobody should need to open the code to understand a line.

Controllers and services add to the line with `log.add(entity, data)`. Entities and
keys are free-form: add whatever explains the flow. A second `add` on the same entity
merges into it.

Not in this phase: levels and error shape, headers, redaction, sampling, jobs,
request/response bodies.

## Rules
- **One entity per thing, owned by its module.** `orders` adds `order`, `payments`
  adds `payment`, auth adds `user`. Keys are `snake_case`.
- **Same entity, same keys** in every flow. `order.id` is never `order_id` elsewhere.
- **Add what you know before a step, then its result after it**, so a step that
  throws still shows what it was doing:

  ```ts
  log.add('payment', { provider: 'paystack' })
  const charge = await paystack.charge(order)
  log.add('payment', { reference: charge.reference, status: charge.status })
  ```

- **Record outcomes, not just errors.** A step that returns a decision without
  throwing still adds it: `log.add('payment', { status: 'declined', reason: 'insufficient_funds' })`.
- **Ids, counts, amounts, statuses, reasons.** Not sentences or free text.
- **Money** is an integer in minor units with its currency:
  `total_minor: 125000, currency: 'GHS'`. Never floats.
- **Third-party results** are the few fields you'd search on, never the raw response.
- **No lists that grow.** Use a count (`item_count`), or at most the first few ids.
- **Omit, don't null.** If a value isn't known, leave the key out.
- **Never added:** passwords, tokens, card or account numbers, full addresses, file
  contents, whole request or response bodies.

## Step 1 — Map each flow
For every flow in the Flows section, read its controller and the services it calls,
and list what the line should say:

| Flow | Step | Entity | Before the step | After the step | Module (file:line) |
|---|---|---|---|---|---|
| create_order | auth | user | | id | auth plugin |
| create_order | insert order | order | item_count | id, total_minor, currency | orders/service.ts:12 |
| create_order | charge | payment | provider | reference, status | payments/service.ts:8 |

Existing project: include what current log lines in those functions already carry,
and say which lines they come from.
Stop. The user reviews the table.

## Step 2 — Personal data
Ask the user to select one for email and phone numbers:

1. **Keep visible**: allowed on the line (quiet shows them by default).
2. **Leave out**: use the user id only.

Stop.

## Step 3 — Pass `log` to services
Services that add to the line take `log` as their first parameter, typed with the
`Log` type from the request event file:

```ts
import type { Log } from '<request event path>'

export async function createOrder(log: Log, userId: string, items: string[]) { … }
```

List every function whose signature changes and every place that calls it.
Stop. The user confirms the list.

## Step 4 — Add the breadcrumbs
Add the reviewed `log.add` calls, in the controller and in each service:

```ts
// orders controller
.post('/', ({ body, user, log }) => {
  log.add('user', { id: user.id })
  return createOrder(log, user.id, body.items)
}, { flow: 'create_order', body: … })
```

```ts
// orders service
export async function createOrder(log: Log, userId: string, items: string[]) {
  log.add('order', { item_count: items.length })
  const order = await db.orders.insert({ userId, items })
  log.add('order', { id: order.id, total_minor: order.totalMinor, currency: order.currency })
  await chargePayment(log, order)
  return order
}
```

```ts
// payments service
export async function chargePayment(log: Log, order: Order) {
  log.add('payment', { provider: 'paystack' })
  const charge = await paystack.charge(order)
  log.add('payment', { reference: charge.reference, status: charge.status })
  if (charge.status === 'declined') log.add('payment', { reason: charge.reason })
  return charge
}
```

Then write an **Entities** section in `docs/logging.md`: each entity, the module
that adds it and its keys, so the next person adds to the same shape.

Existing project: when a log line in these functions only repeated what the
breadcrumbs now carry, remove it. Keep lines that record something the line doesn't
(audit, security).

## Done when
For one flow, show a success line and a failure line where a later step failed.
Reading only the failure line, it is clear who it was for, which step failed, and
what the earlier steps had done. Example:

`{"flow":"create_order","user":{"id":"u107"},"order":{"item_count":2,"id":"ord_u107"},"payment":{"provider":"paystack"},"error":{"name":"Error","message":"paystack timeout"},"status_code":500,…}`

- Every flow in the Flows section has its breadcrumbs.
- No secret, card number or raw provider payload appears on any line.
Stop. Show the diff and the lines.
