# Logging use-case walkthrough

Review examples for the agreed guide, not deployed instrumentation. Handler snippets use the author’s `ctx.get('wideEvent')` convention. Middleware supplies HTTP metadata, timing, error serialization and emission. Runnable [framework translations](../examples/logging/README.md) accompany this walkthrough for TypeScript/Elysia, Python/ASGI, Go/net/http and Rust/Axum.

## Example settings

For these examples only: `orders-api`, production, `POST /orders`; every request is eligible. Availability is 99.9% over 30 days, with success defined as HTTP 201, no recorded error and completed response. Latency is 99% of eligible requests succeeding in **under 500 ms** over 30 days. Retain errors, HTTP >=400 and requests failing either per-request criterion. Sample the remaining requests at 10%. These are editable examples, not product defaults. Each eligible request updates both measurements before sampling. One bad request is not necessarily an aggregate SLO breach.

## 1. Normal success

The handler adds business facts:

```typescript
const event = ctx.get('wideEvent');
event.flow = 'create_order';
event.user = { id: user.id, email: user.email, msisdn: user.msisdn };
event.order = { id: order.id, total_cents: order.total };
return ctx.json(order, 201);
```

```json
{
  "timestamp": "2026-11-17T14:30:00.142Z",
  "level": "info",
  "service": "orders-api",
  "env": "production",
  "request_id": "req_123",
  "method": "POST",
  "path": "/orders",
  "status_code": 201,
  "duration_ms": 142,
  "request": {
    "headers": {
      "content-type": "application/json",
      "authorization": "[REDACTED]"
    },
    "body_capture": "disabled"
  },
  "response": {
    "headers": {
      "content-type": "application/json"
    },
    "body_capture": "disabled"
  },
  "flow": "create_order",
  "user": {
    "id": "usr_123",
    "email": "demo@example.test",
    "msisdn": "+15555550123"
  },
  "order": {
    "id": "ord_456",
    "total_cents": 4999
  }
}
```

For a controlled sampler draw of 0.04, `0.04 < 0.10` selects this event for emission. Availability: good. Latency: good. The draw is a test fixture, not an emitted field.

The remaining JSON fragments show changes or additions to this complete event. They are **not separate log lines**. For independent executions, middleware supplies fresh IDs and completion timestamps. HTTP fields and body markers must reflect each actual response.

## 2. Slow success

```json
{
  "level": "warn",
  "duration_ms": 500
}
```

Always retained at the exact boundary. Availability: good. Latency: bad because the target is strictly under 500 ms. A 499 ms success remains eligible for normal sampling.

## 3. Client error

```typescript
event.error = { code: 'INVALID_ORDER', message: 'An item is required', details: { field: 'items' } };
return ctx.json({ message: 'An item is required' }, 400);
```

```json
{
  "level": "error",
  "status_code": 400,
  "duration_ms": 35,
  "error": {
    "code": "INVALID_ORDER",
    "message": "An item is required",
    "details": {
      "field": "items"
    }
  }
}
```

Always retained. Both measurements: bad under this example’s all-requests population. An explicitly different SLO could exclude specific validation failures; the log would still be retained.

## 4. Unhandled exception

```typescript
throw new Error('Database unavailable');
```

```json
{
  "level": "error",
  "status_code": 500,
  "duration_ms": 210,
  "error": {
    "name": "Error",
    "message": "Database unavailable"
  }
}
```

Middleware captures the exception. The shown 500 is the framework’s actual response; do not assign 500 blindly to every exception. Always retained; both measurements bad.

## 5. Handled failure returned as HTTP 200

```typescript
event.error = { code: 'PAYMENT_DECLINED', reason: 'insufficient_funds', details: 'The bank declined the payment' };
return ctx.json({ accepted: false }, 200);
```

```json
{
  "level": "error",
  "status_code": 200,
  "duration_ms": 180,
  "error": {
    "code": "PAYMENT_DECLINED",
    "reason": "insufficient_funds",
    "details": "The bank declined the payment"
  }
}
```

Always retained. Both measurements: bad. HTTP 200 does not erase the recorded business failure.

## 6. Authentication failure followed by a redirect

```typescript
event.flow = 'sign_in';
event.error = { code: 'TOKEN_EXCHANGE_FAILED', message: 'Identity provider exchange failed' };
return ctx.redirect('/login');
```

```json
{
  "service": "auth-api",
  "flow": "sign_in",
  "method": "GET",
  "path": "/auth/callback",
  "status_code": 302,
  "level": "error",
  "duration_ms": 220,
  "request": {
    "query": {
      "code": "[REDACTED]",
      "state": "[REDACTED]"
    },
    "body_capture": "disabled"
  },
  "response": {
    "headers": {
      "location": "/login"
    },
    "body_capture": "disabled"
  },
  "error": {
    "code": "TOKEN_EXCHANGE_FAILED",
    "message": "Identity provider exchange failed"
  }
}
```

This is a separate auth request, without order fields. Always retained. Excluded from the orders SLO. Under an explicitly configured auth SLO requiring a completed redirect without a recorded error, it is bad.

## 7. More business context and flexible error values

```typescript
event.cart = { item_count: 3, coupon: 'WELCOME' };
event.inventory = { warehouse_id: 'wh_1', reserved: false };
event.error = { code: 'OUT_OF_STOCK', reason: 'inventory_unavailable', details: [{ sku: 'sku_1', available: 0 }] };
```

```json
{
  "level": "error",
  "status_code": 409,
  "cart": {
    "item_count": 3,
    "coupon": "WELCOME"
  },
  "inventory": {
    "warehouse_id": "wh_1",
    "reserved": false
  },
  "error": {
    "code": "OUT_OF_STOCK",
    "reason": "inventory_unavailable",
    "details": [
      {
        "sku": "sku_1",
        "available": 0
      }
    ]
  }
}
```

Assume the handler returns HTTP 409. Objects, arrays, strings, numbers, booleans and null preserve their types. Always retained; both measurements bad. A plain-string error becomes `{ "message": "..." }` during normalization.

## 8. Body capture enabled and credentials redacted

```json
{
  "request": {
    "headers": {
      "content-type": "application/json",
      "authorization": "[REDACTED]"
    },
    "body": {
      "items": [
        {
          "sku": "sku_1",
          "quantity": 1
        }
      ],
      "payment_token": "[REDACTED]"
    }
  },
  "response": {
    "headers": {
      "content-type": "application/json",
      "set-cookie": "[REDACTED]"
    },
    "body": {
      "order_id": "ord_456"
    }
  },
  "user": {
    "id": "usr_123",
    "email": "demo@example.test",
    "msisdn": "+15555550123"
  }
}
```

This route explicitly enables approved request and response projections. Middleware performs capture and redaction; the handler does not log raw bodies. `disabled` is absent because capture is enabled. Email and phone remain visible unless configured for redaction. With the successful baseline result, sampling remains 10%; both measurements good.

## 9. Body shortened to fit the limit

```json
{
  "response": {
    "headers": {
      "content-type": "application/json"
    },
    "body": {
      "order_id": "ord_456",
      "items": [
        {
          "sku": "sku_1"
        }
      ]
    },
    "body_capture": "truncated"
  }
}
```

Assume the original approved response contained more items and exceeded the configured limit. Keep a valid JSON preview, not a sliced JSON string. Truncation changes diagnostics, not success or retention: the baseline remains eligible for 10% sampling and good in both measurements. The full-event limit also applies.

## 10. A successful request is sampled out

```json
{
  "level": "info",
  "status_code": 201,
  "duration_ms": 142
}
```

With a controlled sampler draw of 0.83, `0.83 < 0.10` is false. No detailed event is emitted. Both measurements still receive one good request. Quiet cannot display a log that the producer did not send.

## 11. A business retention condition

```typescript
event.user = { id: user.id, subscription: 'enterprise' };
```

```json
{
  "user": {
    "id": "usr_123",
    "subscription": "enterprise"
  }
}
```

Only when explicitly configured: `shouldSample(event)` retains enterprise requests. This condition reads the existing business field, following the author’s example. It neither invents a helper nor changes SLO eligibility. If enterprise traffic has a distinct SLO, use that objective’s scope and boundaries; failure of any applicable per-request objective forces retention.

## 12. A recovered dependency failure

```typescript
event.payment = { provider: 'example-provider', attempts: 2, retry_reason: 'temporary_unavailable' };
```

```json
{
  "payment": {
    "provider": "example-provider",
    "attempts": 2,
    "retry_reason": "temporary_unavailable"
  },
  "level": "info",
  "status_code": 201,
  "duration_ms": 320
}
```

The dependency retry succeeded inside this HTTP request before completion. Record the history as business facts rather than a terminal `event.error`. This is not a queue job retry: without an explicit business retention rule for dependency retries, this successful request uses normal sampling. Both measurements good. If it took 500 ms or more, latency would be bad and retention mandatory.

## 13. Two services handling one request

Each service enriches and finalizes its own event. A configured client propagates the trusted request ID. These are fragments of two distinct completion records:

```json
[
  {
    "service": "orders-api",
    "request_id": "req_123",
    "flow": "create_order",
    "method": "POST",
    "path": "/orders",
    "status_code": 201,
    "duration_ms": 142
  },
  {
    "service": "inventory-api",
    "request_id": "req_123",
    "flow": "reserve_inventory",
    "method": "POST",
    "path": "/reservations",
    "status_code": 201,
    "duration_ms": 41
  }
]
```

Apply each service’s own SLO and retention rules. Only the orders boundary counts toward the example orders SLO; do not count both service events as two customer requests. No calls list is required. Shared IDs allow correlation, but independent sampling can leave only one event visible.

## 14. A job fails and is retried

Reuse the queue’s actual job ID and attempt fields. These illustrate a queue that uses `job_id` and one-based `attempt`. There are no HTTP fields:

```json
[
  {
    "timestamp": "2026-11-17T14:31:00.000Z",
    "level": "error",
    "service": "order-worker",
    "env": "production",
    "request_id": "req_123",
    "duration_ms": 350,
    "flow": "deliver_order",
    "job_id": "job_456",
    "attempt": 1,
    "order": {
      "id": "ord_456"
    },
    "error": {
      "code": "PROVIDER_UNAVAILABLE",
      "message": "Delivery provider unavailable"
    }
  },
  {
    "timestamp": "2026-11-17T14:31:05.200Z",
    "level": "info",
    "service": "order-worker",
    "env": "production",
    "request_id": "req_123",
    "duration_ms": 200,
    "flow": "deliver_order",
    "job_id": "job_456",
    "attempt": 2,
    "order": {
      "id": "ord_456"
    }
  }
]
```

The array displays two log lines together; emit each attempt as its own JSON record. Both the failed attempt and the confirmed successful retry are always retained, including at a 0% normal sample rate. The recovery remains info because it is a normal-speed success; retention does not promote its severity. Both are outside the HTTP SLO. A job SLO must define whether it measures attempts or eventual delivery before assigning counts; do not assume these are two customer failures. Independently scheduled jobs omit the inherited request ID.

In the agreed Flow activity list, these two observed attempts appear under one job row labelled “Completed after retry · 2 attempts.” Expanding it reveals the failure and success; selecting either opens that attempt's actual event. The agreed sampler retains both, but delivery loss, expiry or a legacy producer can still leave the recovery absent. Without that completion evidence, show the known attempt and missing completion rather than inferring success.

For a separate job timing illustration, suppose the queue reports a 20-second wait followed by a 200 ms execution, with no retry or other intervening delay. The job row reads “Execution 200 ms”; expanded details show “Queue wait 20 s” and “Total elapsed 20.2 s.” An explicitly configured total-elapsed target of under 5 seconds retains this event despite its fast execution. Evaluate it against that job objective, not the HTTP example's 500 ms threshold. If enqueue timing is unavailable, wait and total remain unknown. These are display labels and example values, not new required JSON field names.

## 15. Streaming completion and cancellation

A finite download completes with HTTP 200 after 620 ms. Capture is disabled for the body:

```json
{
  "service": "export-api",
  "flow": "download_report",
  "method": "GET",
  "path": "/reports/export",
  "status_code": 200,
  "duration_ms": 620,
  "level": "warn",
  "response": {
    "body_capture": "disabled"
  }
}
```

For a separately configured export SLO requiring completed HTTP 200 in under 500 ms, availability is good and latency is bad. Retain it at stream completion, not when the handler first returns. It is outside the orders SLO. Long-lived streams need an appropriate separate objective rather than this download example.

If the client disconnects before any response status is sent, the final fragment instead looks like:

```json
{
  "service": "export-api",
  "flow": "download_report",
  "method": "GET",
  "path": "/reports/export",
  "duration_ms": 80,
  "level": "error",
  "error": {
    "name": "AbortError",
    "message": "Client disconnected"
  }
}
```

Omit `status_code` when none was sent. If headers were already sent, retain their actual status alongside the error. Always retain the recorded error. Cancellation counts as bad only if included by the export objective; explicit exclusions remain excluded. Unknown lifecycle observations must not become successes. No event is guaranteed after a process crash that prevents completion hooks.

## 16. Job cancellation, timeout and worker loss

These examples use the detected queue's own lifecycle records and field names; they introduce no universal state field or additional completion log.

- Cancellation requested while executing: keep the evidenced state until cancellation or completion is confirmed. Do not label the job Cancelled merely because a stop request was sent.
- Queue confirms cancellation before execution: show Cancelled from the lifecycle record. There is no execution attempt or duration to invent.
- Queue confirms cancellation during execution: show Cancelled. Include actual attempt timing only when observed; a cancellation signal alone does not establish when execution stopped.
- An attempt times out and another is scheduled: retain the attempt's error and timeout reason; show Retry scheduled only with the scheduling evidence.
- Queue confirms terminal failure after a timeout: show Failed, with the timeout explanation available in the attempt details.
- Worker disappears and no completion or authoritative lifecycle result arrives: show Completion not observed. Do not manufacture a completion log or infer terminal failure from silence.

The user's SLO defines cancellation eligibility and failure/exclusion treatment. Attempt timeouts and eventual job completion are assessed against their respective configured objectives; a planned retry does not itself prove eventual failure or recovery.

## 17. Approved request → job → retry → child-job walkthrough

This is the agreed end-to-end reading example. Values are illustrative, and the queue adapter obtains identity, relationships, timings and state from the user's actual library. For a complete demonstration, normal sampling is 100%; the failed attempt and confirmed recovery below remain mandatory retention even if normal sampling is reduced to 0%.

1. `POST /orders` enqueues `process_order` and returns HTTP 202 in 40 ms. The request event records acceptance. It does not claim that background order processing completed.
2. The job waits 1 second before its first attempt. That attempt runs for 350 ms and fails. Its error event is retained. Native queue evidence confirms a retry after a 2-second delay, so the job row reads Retry scheduled.
3. The second attempt executes for 200 ms and completes successfully. Its event is also retained. The job row reads “process_order · Completed after retry · 2 attempts.” The collapsed execution timing identifies the latest attempt: “Execution 200 ms · attempt 2.” Expanding reveals the failed first attempt, retry delay, successful second attempt, initial wait and total elapsed time.
4. With complete queue timing evidence and no additional delay, total elapsed from enqueue to confirmed completion is 1,000 + 350 + 2,000 + 200 = 3,550 ms. A user-configured job SLO requiring completion in under 3 seconds therefore classifies this job as late despite eventual success. The eventual-success objective may pass while the latency objective fails. The earlier HTTP-only example does not define this job's SLO.
5. During processing, the job creates `reserve_stock` and `send_receipt`. Show them beneath the parent only when native queue relationships establish the links. They may run independently. Each has its own observed state, attempts, completion events and applicable SLOs. In this example the queue permits parent completion before child completion; adapters must respect different dependency semantics in other queues.
6. Selecting either attempt opens its actual event in the existing field card. The recovery does not hide the earlier error. Headers, bodies and business data remain subject to the same redaction and size limits. A queued child has lifecycle evidence rather than a fabricated completion summary.

HTTP acceptance, attempt failure, recovered job completion and child-job progress remain separate facts in one activity list. Successful recovery keeps its appropriate level under the configured rules; mandatory retention alone does not promote it to warning or error. If delivery loss or expiry removes part of this evidence, show incomplete history rather than reconstructing an assumed result.

## What this verifies

The JSON examples are parseable and use the agreed field placement. These are documentation fixtures, not a claim that middleware, sampling, redaction or SLO ingestion is implemented or tested in the app. The language-specific functions remain the next implementation deliverable after review.
