# Canonical logging for quiet

Guide manuscript · agreed logging model and Flow direction · 17 November 2026

This guide describes the agreed producer contract and the corresponding reading experience. The [language-specific reference examples](../examples/logging/README.md) implement the producer pattern for review and adaptation. Quiet's ingestion enforcement, SLO aggregation, in-app guide and reading experience still require implementation. See [the implementation proposal](logging-proposal.md) for current behavior and rollout. Existing logs remain supported.

For product-specific setup, browse the [20 product templates](logging-product-templates.md), including payments, buy now/pay later, food ordering and event ticketing. Each pack proposes customer-workflow goals that can be selected and edited before inclusion in the logging prompt.

## 1. What a canonical event is

Emit one structured completion event for each unit of work in each service: one HTTP request, one job attempt, or one scheduled run. Enrich that event while the work runs. Emit it when the work finishes, fails or is cancelled. This is the wide-event pattern described in [Stripe's canonical logging article](https://stripe.com/blog/canonical-log-lines).

When the user enables sampling, build one complete event for every unit, then emit only those selected by the agreed rules. Events matching explicit retention conditions, recorded errors and events meeting the configured slow/status rules bypass random sampling. SLI measurements still include every eligible unit.

For example, an order request should tell you which service and deployment handled it, the matched route, result, duration, safe customer context, and whether a dependency failed. You should not have to reconstruct the answer from ten disconnected messages.

“One” applies to the canonical summary, not every log emitted by the process. Preserve useful application, security, audit and library events. Label them separately; do not count them as requests. Remove redundant progress logging deliberately, not by disabling whole severities or dropping records without request IDs.

Business fields live directly on the event, following the author's convention: for example `flow`, `user`, `cart` and `payment`. There is no `context` or `wideEvents` wrapper in new events. The old `wideEvents` field is legacy input only. The proposed contract has no `calls` array or call-recording helper. Handlers enrich the event directly.

## 2. The event contract

The agreed core shape is `timestamp`, `level`, `service`, `env`, `request_id`, `method`, `path`, `status_code`, `duration_ms`, `request`, and `response`, with an optional `error` and business fields directly on the event. Follow the author's top-level `method`, `path` and `status_code` convention. Request/response headers and optional bodies stay grouped under `request` and `response`; do not duplicate the top-level HTTP fields inside them. Runtime readers must continue to support legacy records.

Automatic metadata is agreed: configure `service` and `env` once, generate or propagate `request_id`, measure `duration_ms` with a monotonic clock, and set `timestamp` when the request finishes as an ISO 8601 UTC string. Handlers supply none of these fields. Emit only one event timestamp; legacy `time` inputs remain readable without adding a duplicate field to new records.

| Field                                   | Contract                                                                                                                                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `timestamp`                             | Completion timestamp as an ISO 8601 UTC string, such as `2026-11-17T14:30:00.142Z`. Collector arrival time is separate transport metadata.                                                                                                                                           |
| `level`                                 | Automatically assigned: recorded error or HTTP >=400 → `error`; otherwise a completed successful request meeting the configured slow threshold → `warn`; otherwise a completed successful request → `info`. No separate success level. Existing diagnostic logs retain their levels. |
| `service`, `env`                        | Configured once at middleware setup and attached automatically.                                                                                                                                                                                                                      |
| Existing deployment metadata            | Preserve useful service version, region or deployment fields already configured on the logger, as in the author’s examples. No additional mandatory fields.                                                                                                                          |
| `flow`                                  | Stable business operation name, such as `create_order` or `sign_in`. The stream's primary operation label; not a unique correlation ID.                                                                                                                                              |
| `msg`                                   | Legacy input field; new producers do not duplicate `flow` here.                                                                                                                                                                                                                      |
| `request_id`                            | Correlation across related work. Validate trusted incoming IDs or generate a new one.                                                                                                                                                                                                |
| `trace_id`, `span_id`, `parent_span_id` | Include when tracing supplies them. Never generate fake span IDs just to fill fields.                                                                                                                                                                                                |
| `method`, `request.route`, `path`       | HTTP method, matched route template, and sanitized path without query/fragment. Omit path if it cannot be safely sanitized.                                                                                                                                                          |
| `status_code`                           | Actual HTTP response status, when sent. Do not invent 499/500 when no response was sent.                                                                                                                                                                                             |
| `duration_ms`                           | Finite, nonnegative elapsed milliseconds from a monotonic clock; HTTP completion includes streaming time where observable.                                                                                                                                                           |
| `request`, `response`                   | Safe structured HTTP context, described below.                                                                                                                                                                                                                                       |
| `error`                                 | Extensible structured error. Preserve available standard/custom fields and their JSON types; normalize a plain-string error to `{ message }`. Redact and bound the whole object.                                                                                                     |
| Business fields                         | Assign directly to the event, for example `flow`, `user`, `cart` or `payment`. No enclosing business-context wrapper.                                                                                                                                                                |
| Existing job metadata                   | Use the queue or scheduler’s actual job identifier and attempt/run information where relevant; do not invent HTTP fields for jobs.                                                                                                                                                   |

For canonical producers, recorded errors and HTTP statuses >=400 are `error`. A completed successful request is `warn` when its duration meets the configured slow threshold, otherwise `info`. Error takes priority over slowness. Successful completion means the observed response completed with a 2xx/3xx status and no recorded error; do not infer success for an aborted or unobserved response. A failed OAuth exchange followed by a redirect retains `status_code: 302` and its recorded `error`. Do not infer request failure from an arbitrary nested field named `error`; use the event's top-level `error` and actual HTTP status.

Keep quiet's existing four filters: `debug`, `info`, `warn`, `error`. Existing `trace` records stay grouped under Debug, and `fatal` under Error. New producers emit lowercase level names; native numeric formats need the appropriate adapter mapping. Badges, filter counts, histograms, stream and search must agree. Warnings and errors bypass normal canonical-event sampling; changing a view filter does not change collection or SLI counts. Severity itself is not an SLI. Existing application/library logs retain their original levels.

Business context should answer operational questions: `account_id`, `plan`, `report_id`, `item_count`, `total_cents`, or a relevant feature flag. These are examples, not a compulsory shopping-cart schema. Opaque IDs can still be sensitive; capture only authorized identifiers and restrict access. Never use request IDs, user IDs or arbitrary paths as metric labels.

Handlers retrieve the middleware's event and assign fields directly: `event.flow = "create_order"` and `event.order = { id: "ord_example" }`. The stream reads `flow`, `status_code`, duration and any recorded error. Its summary can read `create_order · 201 · 142 ms`. Emission rules use recorded errors, HTTP status, duration and configured retention conditions. `flow` describes the operation; request/trace/job IDs still correlate individual executions.

## 3. Requests, responses and capture states

Use `request.headers`, `request.params`, `request.query`, and optional `request.body`. Use `response.headers` and optional `response.body`. The HTTP method, sanitized path and actual HTTP status live at top-level `method`, `path` and `status_code`. Do not duplicate these inside `request` or `response`. Include `request.route` when a matched template is available for aggregation.

Headers use lowercase names, strings for single values and arrays for repeated values. Query parameters follow the same string-or-array convention so repeated keys survive. Omit empty `params` and `query` objects. Route parameters use the framework's matched parameter names. Redacted values use the string `[REDACTED]`; header/query values retain their string or array shape. Preserve structured JSON bodies rather than embedding stringified JSON.

### Body capture — agreed

Body capture is off by default and enabled per route, separately for requests and responses. Captured values are redacted and size-limited; files and streaming bodies are skipped. The middleware captures approved fields automatically.

Use a small `body_capture` marker directly inside `request` or `response` when explaining disabled or shortened capture:

```json
{
  "method": "POST",
  "path": "/auth/login",
  "status_code": 200,
  "request": {
    "body_capture": "disabled"
  },
  "response": {
    "body_capture": "disabled"
  }
}
```

```json
{
  "status_code": 200,
  "response": {
    "body": {
      "order_id": "ord_456"
    },
    "body_capture": "truncated"
  }
}
```

These are fragments. `disabled` means capture was switched off and the body is omitted. `truncated` means the safe captured representation was shortened to fit its limit; it remains valid JSON. Redacted values still display `[REDACTED]`. Absence of a body and marker means unknown, never an assumed empty body.

A redacted, truncated body keeps `[REDACTED]` markers inside its valid shortened JSON. A missing body does not prove it was empty. Files, unsupported content and streaming bodies are omitted; do not invent capture metadata or label a skipped body as disabled when capture was enabled.

### Safe defaults

Capture the agreed request/response metadata automatically. Enable body previews only per route, direction and content type, with explicit allowed fields. A checkout route might allow `item_count` and `currency`, while authentication routes have body capture disabled. Do not read or clone an unbounded stream solely for logging. Observe already-parsed request data and deliberate response projections at the application boundary.

Agreed configurable defaults: 8 KB per captured body and 32 KB for the complete serialized event. For configuration, use 8,192 and 32,768 bytes respectively (8 KiB and 32 KiB). Users can change both values in the setup prompt; these are producer defaults, not changes to current quiet settings. Measure UTF-8 serialized bytes after redaction. The full-event limit wins and must remain below the deployed receiver's line limit.

When an event exceeds the limit, shorten body previews first and mark each shortened side with `body_capture: truncated`. Preserve request ID, flow, HTTP status, duration and core error information. Keep JSON valid; never cut the serialized byte string. If optional context also exceeds the remaining budget, bound it before emission. Report a safe logging failure if a valid minimal event cannot fit; never emit an oversized or unsanitized fallback. Logging failure must not change the application's result.

## 4. Redaction is a data boundary

Agreed defaults: one shared redaction configuration covers request, response, business context and errors. Built-in rules redact passwords, tokens, authorization headers and cookies. Email addresses and MSISDN/phone values remain visible by default when included in captured data; users can opt them into custom redaction. Users can add app-specific sensitive fields. Redacted values become `[REDACTED]` before logging. Custom rules add protection without disabling the built-in defaults.

Remove secrets **before stdout, a file, an exporter queue or OTLP**. UI masking cannot undo an earlier leak. Apply a second policy at quiet's ingestion boundary before indexing, disk, in-memory buffers and WebSocket delivery. Exports and copy actions consume the same sanitized representation.

Use explicit allowlists for headers and body fields. Never capture authorization/proxy authorization, cookies/set-cookie, API keys, passwords, access/refresh tokens, payment credentials, or OAuth code/state values. Email addresses and MSISDN/phone values are not redacted by default. A user-configured sensitive-field rule may redact them; this does not enable capture of otherwise excluded fields or bodies. If it helps explain the request, retain a safe field name and a marker showing removal. Do not record secret-derived prefixes, lengths, hashes or raw originals as “redaction evidence.” This follows the data-minimization direction in [OWASP's logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html). Explicit header capture is also recommended by [OpenTelemetry's HTTP conventions](https://opentelemetry.io/docs/specs/semconv/http/http-spans/).

Apply policy to nested arrays/objects, headers regardless of casing, URLs and query strings, response `location`, error messages/stacks/details and business context. Allowlisting a free-text field does not make its contents safe: use controlled summaries or an explicit value policy. Key matching alone cannot find secrets in arbitrary text or encoded JSON. Bound parsing of structured strings; when a value cannot be safely inspected, omit it and report why. Do not log raw SQL parameters, connection strings, file contents or binary payloads.

Use `[REDACTED]` at the affected field to make removal visible. Do not require an extra redaction envelope, provenance object or per-field reason list. A marker indicates removal but does not certify that all sensitive data was found.

“Raw” in the proposed UI means **sanitized received record**, with that label visible. There is no secret reveal action. Redacted fields can be filtered by marker presence, never by the removed value. Changing a policy protects future events; old stored data needs a separately planned purge or migration, including indexes and backups. Do not silently purge history.

## 5. Adapt the author's middleware and sampling functions

The middleware approach follows [Logging Sucks — Implementing Wide Events](https://loggingsucks.com/#implementing-wide-events): initialize request-local context, let handlers enrich it with business facts, then emit once on completion, including errors. The article also describes making sampling decisions after completion, using the finished event's context.

Use Boris Tane's `wideEventMiddleware()` and `shouldSample(event)` examples as the implementation baseline. The installed `logging-best-practices` skill's `rules/structure.md` also contains `wideEventMiddleware()` and a single startup logger. These are reference implementations to adapt, not an SDK with ready-made integrations for every language. Preserve attribution when adapting source code.

Translate the same lifecycle into each framework: an Elysia plugin, or the target framework's middleware and request-local event. Follow the author's direct enrichment convention rather than adding a recorder class or custom helper API. The earlier helper proposal is superseded.

Make remaining adaptations explicit: additional request/response headers and optional bodies, no outcome or calls, configurable retention thresholds, redaction and bounded capture, and quiet's existing level filters. Business fields and HTTP method/path/status follow the author's top-level convention. The skill recommends info/error; our previously agreed slow-success warn classification is a deliberate difference. The article's sampling percentages, latency threshold and business-specific retention conditions are examples, not defaults to activate in the user's service.

For quiet, adapt that teaching example to the contract above:

- Preserve recorded errors even when a handler returns normally, such as a failed sign-in followed by a redirect.
- Read the actual final HTTP status rather than assigning 500 to every thrown exception.
- Use monotonic elapsed time and a completion timestamp, matching quiet's existing flow timing.
- Sanitize and bound the event before emission; business context is not permission to capture full payloads.
- Use the framework's terminal response hooks for streaming and cancellation, with a finish-once guard.
- If diagnostic events are tail-sampled, update unsampled SLI counters first. Keeping failures more often than successes biases ratios computed directly from retained logs. Use the user's supplied thresholds and sampling rate; without an explicit sampling policy, keep every event.

Keep the implementation centered on a request-local event and a completion-time sampling decision.

```text
at startup:
  configure existing JSON logger + deployment context + capture policy once

wideEventMiddleware(config), or the framework's equivalent plugin:
  create request-local event, monotonic start and completion guard
  make the event available to handlers for direct enrichment

handler:
  add safe business context and record handled errors when needed
  let the framework handle the actual response or propagated exception

on terminal response/job/run signal:
  finishOnce(actual result):
    atomically claim completion; ignore later terminal callbacks
    read final status, error and cancellation state
    compute duration; build event; sanitize; enforce size limits
    assign level: error first, then slow-success warn, then normal-success info
    record unsampled bounded-label metrics using the same result semantics
    call shouldSample(completed event, config)
    enqueue the selected summary once through the existing logger
    on logging failure: increment a health counter; preserve application result

shouldSample(completed event, config):
  keep eligible events that fail any applicable SLO's per-request criteria
  keep confirmed successful job completion after a retry
  keep warn/error events and matching retention rules
  otherwise apply the user's normal-request sample rate (100% if unspecified)
```

Following the author's access pattern, a handler enriches the shared event directly:

```typescript
const event = ctx.get("wideEvent");
event.flow = "create_order";
event.user = { id: user.id, subscription: user.subscription };
event.order = { id: order.id };
```

Business fields must not overwrite middleware-owned metadata such as request IDs or timing. State stays request-local, with synchronization where concurrent work updates it. Finalization takes a stable snapshot; later writes do not alter an emitted record. Child work that outlives its parent gets its own unit and linked IDs.

Handlers may set `event.error` for a handled failure, as in the author's example. Middleware owns finalization. Retention conditions belong in `shouldSample(event)` and never emit early or bypass redaction. Use the user's SLO scope, success criteria and latency boundaries to determine which events must be retained. Business-field conditions use those same definitions where applicable. No separate manual force-retention method is required.

### Errors — agreed

Middleware records unhandled errors automatically. Handlers assign structured handled-error details to `event.error`. Recorded errors bypass sampling, but the middleware still emits only the completed event once. Omit `error` when none was recorded.

The error object is extensible: preserve useful fields such as `code`, `message`, `name`, `reason`, `details` and an optional `stack`, plus codebase-specific fields. Do not require missing fields or stringify structured values. `reason` and `details` may be strings, numbers, booleans, null, arrays or objects; preserve their JSON types. Native error serializers must extract standard fields even when they are not enumerable. Support a custom serializer for unusual error classes, then apply the same redaction and size limits to its result. Circular references must not break logging or the request.

For example:

```json
{
  "error": {
    "code": "PAYMENT_DECLINED",
    "message": "Payment could not be completed",
    "reason": "insufficient_funds",
    "details": "The issuing bank declined this transaction"
  }
}
```

A plain-string error is normalized to:

```json
{
  "error": {
    "message": "Payment provider timed out"
  }
}
```

These are event fragments. In the UI, show available `code` and `message` first and let readers expand additional fields. Plain-string field values remain strings; JSON objects and arrays stay structured.

The HTTP adapter must distinguish **handler returned** from **response completed**. A generic `finally` around a handler may run before a streamed body is sent. Capture response completion, disconnect and exceptions using the framework's actual lifecycle, then use a shared finish-once guard. Register response headers before they are committed. A crash, kill or machine failure may prevent all completion hooks; this is why independent ingress metrics and delivery monitoring matter. “Exactly once” here is a producer lifecycle property, not an end-to-end delivery guarantee.

### How this maps to your language

These are framework adaptation notes, not additional handler helper APIs supplied by quiet. Inspect the installed framework version before implementing its hooks. Runnable [TypeScript/Elysia, Python/ASGI, Go/net/http and Rust/Axum references](../examples/logging/README.md) accompany this guide, each with a demo, tests and explicit lifecycle limits. Their worker wrappers demonstrate the same pattern; native queue integration still depends on the user's codebase.

| Stack                | Context and logger                                                                                                                                 | Terminal behavior to implement and test                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node / TypeScript    | Existing pino or equivalent instance; AsyncLocalStorage or explicit request state holding the event; assign business fields directly.              | Finish/close/error paths share one guard. Error handler records the final mapped result. Verify streaming and middleware order.                                                                                         |
| Bun / Elysia or Hono | Existing JSON logger; request-scoped plugin/context handle, never shared plugin state.                                                             | Use the installed framework's response/error hooks. If a hook only sees response creation, use a body adapter for end-of-stream; record unobservable transport completion as unknown.                                   |
| Python               | Existing structlog/logging JSON setup; ContextVar with token reset, or explicit request state holding the event dictionary.                        | For ASGI, wrap send/receive to observe final body and disconnect, plus exception/cancellation paths. For WSGI, account for iterable completion/close. Handler return alone is insufficient.                             |
| Go                   | Existing slog/zap instance; request-local event in `context.Context`, enriched directly.                                                           | Wrap ResponseWriter without losing flush/hijack/optional interfaces. Record write status, context cancellation and panic handling; defer completion consistently with recovery middleware and rethrow when appropriate. |
| Rust                 | Existing tracing subscriber/JSON logger; request extensions or an explicitly passed event, enriched using idiomatic ownership and synchronization. | Tower/Axum middleware and response-body completion wrapper; cancellation/drop and error handling share a guard. A tracing span alone is not a canonical summary event.                                                  |
| Other                | Existing structured logger plus framework-native request scope.                                                                                    | Choose the actual terminal hooks, implement the same contract and run the same behavior fixtures.                                                                                                                       |

Do not copy an entire request/framework context into services. Pass business arguments and the request-local event where needed. For asynchronous jobs, propagate correlation explicitly in the job envelope; thread/task locals do not cross queues.

### Request IDs — agreed

The middleware reuses a valid `x-request-id` from a configured trusted upstream service, or generates a new ID when the incoming value is absent, invalid or untrusted. Keep it in isolated request context, include it as top-level `request_id` in the event, and set the `x-request-id` response header before headers are committed.

Configured HTTP-client and queue adapters forward that ID to the application's own services and to background jobs started by the request. Handlers do not manually attach it on each operation. Do not forward it indiscriminately to third parties. A job started independently has its own job identity and does not invent a parent request ID.

`flow` names the operation; `request_id` correlates one request and its related work. It is not an authentication credential or a unique identifier for every log event. Verification covers trusted propagation, fresh IDs for untrusted or malformed input, response headers, concurrent request isolation, and HTTP-to-job continuity.

Check the primary lifecycle references when building adapters: [Node HTTP](https://nodejs.org/api/http.html), [Elysia lifecycle](https://elysiajs.com/essential/life-cycle.html), [Starlette middleware](https://starlette.dev/middleware/), [Go HTTP interfaces](https://pkg.go.dev/net/http#Flusher), and [Tower HTTP tracing callbacks](https://docs.rs/tower-http/latest/tower_http/trace/index.html). Local response completion does not prove the client received or consumed it. Define that measurement boundary explicitly; upgraded connections and long-lived streams need their own completion policy.

### Job attempts and scheduled work

**Interrupted work — agreed:** show Cancelled only when the queue confirms cancellation; a cancellation request does not prove execution stopped. A timed-out attempt retains its error and timeout reason, with Retry scheduled or Failed based on the queue's confirmed next state. Worker disappearance alone yields Completion not observed unless stronger lifecycle evidence exists. Do not manufacture a completion event when no completion hook ran. Cancellation before execution is represented by the queue's lifecycle record, without an invented attempt or execution duration. The user's SLO defines cancellation eligibility and whether it counts as a failure or exclusion. Timeout is an attempt explanation, not a separate job state.

**Child jobs — agreed:** jobs created by another job remain independent units, each with its own attempts, completion events and applicable SLO treatment. Reuse the detected queue's native parent/child relationships and preserve an originating request ID when available. Show evidenced children beneath their parent without implying sequential execution. A collapsed parent may show the known child count, such as “2 child jobs”; distinguish an observed count from a complete queue-reported count. Parent completion does not imply child completion. If the queue's lifecycle explicitly waits for child dependencies, reflect that behavior. When the relationship is unknown, show related work rather than inventing a hierarchy.

**Retry recovery retention — agreed:** always retain failed job attempts and confirmed successful completion after a retry, even when the recovery is fast and normal sampling is 0%. Use the detected queue's native retry history and completion evidence in `shouldSample(event)`; interpret attempt numbering according to that library rather than assuming it starts at one. Normal successful first attempts remain subject to normal sampling and the other retention rules. Recovery keeps its appropriate info/warn level and does not change SLO eligibility or classification. This is an additional retention condition using the author's sampling pattern, not a new helper API. Delivery loss or expiry can still leave incomplete history; retention selection is not a delivery guarantee.

**Job state — agreed:** map the detected queue's native lifecycle evidence to Queued, Running, Retry scheduled, Completed, Completed after retry, Failed, Cancelled, or Completion not observed. Queued/Running require observed lifecycle signals. Retry scheduled requires confirmation that another attempt is planned. Completed states require successful completion evidence; Failed requires confirmed terminal failure, not just an attempt error. Use Completion not observed when the available records do not establish a terminal result and no reliable current lifecycle state is available. These are UI state labels, separate from log levels; each failed attempt keeps its error severity even if the job later succeeds. Do not infer states from the absence of logs or add a mandatory state field without inspecting the queue's existing conventions.

**Job timing — agreed:** show execution time on the job row with an explicit label. Show queue wait and total elapsed time in expanded details when supplied by reliable queue lifecycle data. The user's SLO determines which measurement controls retention; fast execution does not override a queue-wait or total-elapsed failure. Keep missing measurements unknown. Reuse existing timing fields and explain their start/end boundaries, including whether retry delays are included. For grouped attempts, identify the attempt whose execution time is shown; do not infer a full job duration from incomplete attempts.

The job system belongs to the user's codebase. Inspect installed queue/scheduler libraries, versions, producers, workers and existing instrumentation before choosing hooks or field mappings. Support multiple systems when present, and skip job instrumentation when there are none. Ask the user only when the intended system or semantics cannot be established from the code. Do not require a queue-library choice just to use the guide.

For each detected system, reuse its actual job/queue identity, attempt numbering, parent relationships, lifecycle signals and timing semantics. Explain how these map to quiet's request/job rows and expanded attempts. Missing capabilities remain unknown; do not invent parent links, retry states or timestamps. The author’s wide-event lifecycle remains the basis, while worker hooks come from the detected library's documentation. User-supplied SLOs determine whether measurement covers attempts, eventual job completion, queue wait or execution time.

Emit one summary for each actual job attempt, using the queue’s existing job ID and attempt fields. A failed attempt records its error; include known retry information when useful. Preserve parent `request_id` when one exists; jobs started independently do not invent one. Reuse the scheduler’s run identity where available.

If operationally necessary, queue pickup or transition logs remain ordinary operational logs. They are not additional canonical summaries. Avoid emitting both `attempt_failed` and a duplicate completion summary for the same attempt. Use the existing queue identity conventions.

## 6. Agreed JSON shape and examples

This is the agreed simple shape:

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
    "body_capture": "disabled"
  },
  "flow": "create_order",
  "order_id": "ord_456"
}
```

The examples use the agreed fields. Business fields vary by application; existing job identity fields are included only for job work.

### Complete use-case walkthrough

See [the use-case examples](logging-use-cases.md) for success, errors, business enrichment, redaction, body capture, SLO-based sampling, cross-service correlation, job retries and streaming/cancellation. Each example explains handler behavior, event fields, retention and SLO treatment using explicit example settings. The [runnable middleware references](../examples/logging/README.md) translate the pattern into four languages. Their demos use illustrative configuration; supply your own SLOs and trusted capture policy before adapting them to a service.

Successful request:

```json
{
  "timestamp": "2026-11-17T12:00:00.142Z",
  "level": "info",
  "service": "orders-api",
  "env": "production",
  "request_id": "req_example_01",
  "method": "POST",
  "path": "/orders",
  "status_code": 201,
  "duration_ms": 142,
  "region": "eu-west",
  "instance_id": "api-01",
  "request": {
    "headers": {
      "content-type": "application/json"
    },
    "route": "/orders",
    "body_capture": "disabled"
  },
  "response": {
    "headers": {
      "content-type": "application/json"
    },
    "body_capture": "disabled"
  },
  "order_id": "ord_example",
  "plan": "pro",
  "item_count": 3,
  "flow": "create_order"
}
```

Failed request that redirects the browser (headers and bodies deliberately omitted here):

```json
{
  "timestamp": "2026-11-17T12:00:00.518Z",
  "level": "error",
  "service": "auth-api",
  "env": "production",
  "request_id": "req_example_02",
  "method": "GET",
  "path": "/auth/callback",
  "status_code": 302,
  "duration_ms": 518,
  "request": {
    "query": {
      "code": "[REDACTED]",
      "state": "[REDACTED]"
    },
    "route": "/auth/callback",
    "body_capture": "disabled"
  },
  "response": {
    "body_capture": "disabled"
  },
  "error": {
    "name": "AuthError",
    "code": "TOKEN_EXCHANGE_FAILED",
    "message": "Identity provider exchange failed"
  },
  "flow": "sign_in"
}
```

Retrying job attempt:

```json
{
  "timestamp": "2026-11-17T12:00:00.900Z",
  "service": "order-worker",
  "env": "production",
  "request_id": "req_example_01",
  "duration_ms": 357,
  "level": "error",
  "job_id": "order-worker:delivery:1182",
  "attempt": 2,
  "next_retry_in_ms": 5000,
  "error": {
    "name": "ProviderError",
    "code": "TEMPORARY_UNAVAILABLE",
    "message": "Delivery provider unavailable"
  },
  "order_id": "ord_example",
  "flow": "deliver_order"
}
```

## 7. Read and investigate

The agreed stream layout keeps the existing design: Flow displays `flow`; Summary displays method, path and HTTP status. Timestamp, level, request ID and duration remain in their existing columns. For example: `info · create_order · POST /orders → 201 · 142 ms`. If `flow` is absent, use method plus matched route (sanitized path when no route template exists), then the existing legacy label. Do not require older records to adopt the new schema before they can be read.

Start with service, environment, operation, HTTP status, recorded error and duration. Use request/trace IDs to follow related services and jobs. Select the actual summary event before inspecting Request, Response, Context and Error. A flow can include ordinary logs and spans without treating them as additional requests.

Flow opens as an activity list: one row per request or logical job, showing its name, service, observed state and duration. Expand a job to inspect its attempts and errors, then select an attempt to open that event in the field card. A verified successful retry can read “Completed after retry” without hiding earlier failures or introducing a new log level. Each attempt still produces its own canonical summary; collapsing them is a reading convenience.

Show child jobs beneath their parent only when queue relationships or tracing establish that link. Shared correlation IDs alone indicate related work. Keep parallel jobs from appearing sequential, and distinguish HTTP acceptance from background completion. Service and worker identity remain supporting row information. Detailed timing is available through an explicit action; the graph, minimap and zoom controls leave the default Flow view. The field card's Diagram tab remains available for inspecting an individual event.

Queued and Running require queue lifecycle evidence. For known work whose completion is missing, show “Completion not observed”; a missing log is not proof that a job is still running. A failed attempt is not automatically a final job failure. Group attempts using the queue's actual identity and scope, and surface incomplete history caused by sampling or retention. Label execution duration, queue wait and end-to-end time distinctly when those measurements exist.

The agreed detail view reuses the existing field card and its Fields / JSON / Raw / Diagram tabs. Fields groups request method/path/headers/parameters/body under Request, response status/headers/body under Response, and top-level `flow` plus business fields under Context. Context is a presentation group only, not a JSON wrapper. Show Error only when present, with additional fields expandable. Keep timestamp, service, environment, request ID and duration in a compact summary. Bodies expand on demand; `body_capture` supplies the Disabled or Truncated label. Preserve the existing visual style and resizable card.

Show Disabled/Truncated body markers and redacted values where present. Treat missing capture information as unknown rather than inferring why data is absent. Offer sanitized JSON for exact inspection and safe copying. A failed redirect should show both “Application failed” and “HTTP 302”; a slow successful request should show its measured duration rather than a guessed warning state.

Use “Check my logs” to validate relevant completion records, with explicit limitations when identifying them heuristically. A small recent sample can find malformed events; it cannot prove there are no missing events or no secrets anywhere. The UI should state sample size/window and distinguish malformed, legacy, not applicable and unknown coverage.

## 8. SLOs and SLAs

An SLI is a measurement, an SLO is its target over a defined window, and an SLA is an external commitment with defined consequences. Establish the SLI and operational response before turning a percentage into a customer promise. [Google's SRE workbook](https://sre.google/workbook/implementing-slos/) grounds SLOs in user-visible reliability.

### Define one user-facing boundary

For each objective, specify owner, service/environment, route or operation, population, good/bad criteria, measurement source, window, target, exclusions, missing-data treatment and policy version. Start with a critical user journey such as creating an order, rather than every route.

Example proposal: production `POST /orders`, target 99.9% over rolling 30 days. Count one unique completed ingress request at the chosen boundary. For this example, a good result has `status_code: 201`, no recorded error, and a completed response. Document expected validation/client cancellations explicitly. Count overload 429s and server failures as bad; do not remove failures from the denominator just because they are inconvenient. Track exclusions separately.

Define latency separately, for example 99% of eligible requests both succeed and complete within 500 ms. Under that definition failures are bad, not discarded. If you instead measure latency only among successful requests, label that conditional population and keep an availability objective alongside it. Percentiles help diagnosis; a threshold-based good/eligible ratio makes budget accounting direct.

### Calculate the budget

```text
N = eligible unique units
G = good eligible units
B = N - G
T = target as a fraction
SLI = G / N
allowed_bad = (1 - T) * N
remaining_bad = allowed_bad - B
remaining_fraction = remaining_bad / allowed_bad
burn_rate(window) = (bad_in_window / eligible_in_window) / (1 - T)
```

For 100,000 eligible requests at 99.9%, the allowance is 100 bad requests. If 60 are bad, 40% of the budget remains. Over-budget values may be negative. With no eligible traffic, show **No data**, not 100%. With an incomplete measurement window or known loss, show **Insufficient coverage** and the affected interval.

For an initial 30-day alert policy, fast burn can require both 1 hour and 5 minutes above 14.4×; slower burn can require both 6 hours and 30 minutes above 6×. These consume about 2% and 5% of the period's budget respectively at steady traffic. Tune volume handling, ownership and routing; low traffic also needs appropriate synthetic checks. The paired-window approach comes from [Google's alerting chapter](https://sre.google/workbook/alerting-on-slos/).

Thresholds depend on the objective window: `burn threshold = budget fraction to spend * objective duration / alert duration`. Do not copy 30-day thresholds into a 7-day objective unchanged. For 2% in 1 hour over 7 days, the threshold is 3.36×. UI presets should recompute or explain their assumptions.

### Measure independently of the log view

Recommended architecture: unsampled request counters and duration histograms at the boundary, using the same classification rules as canonical summaries; canonical logs provide investigation context. Instrument ingress/load balancers or external checks too, because requests that never reach the app cannot produce its completion event. Do not add edge counts and application counts together as if they were distinct requests.

If quiet derives SLIs from logs, it needs durable, deduplicated aggregation before raw-log expiry, counters for rejects/loss, a late-arrival policy, and independent coverage evidence. A sample containing all observed records cannot prove all expected records arrived. Label producer sampling, queue losses, restarts, incomplete periods and ingestion gaps. Diagnostic logs may be sampled elsewhere; denominator metrics must not inherit that sampling.

Use bounded metric dimensions: service, environment, route template, operation and a controlled result class. Store objective definitions/version history separately from log payloads. A request records facts; it should not embed today's SLO target or SLA contract terms.

Malformed summaries or missing fields required by the selected SLI are unclassified observations, not successes. Count them separately and mark affected log-derived windows as insufficient coverage unless the objective has an explicit conservative classification. Do not quietly exclude unknown results to improve a percentage.

For SLA reporting, retain sufficient aggregate history for the whole reporting period and agreed correction window. Freeze/version the agreed definition, timezone, calendar boundaries, exclusions and measurement source. Produce a report with numerator, denominator, coverage, exclusions and incident references. Never label a partially observed month “SLA met.” The exact commitment and remedies are a product/commercial decision, not inferred from a log status code.

## 9. Verify the complete path

Before release, run the producer through its real collection route into quiet, then inspect persisted output and every read surface. Use synthetic secret sentinels and controlled request IDs and job identities, never real credentials.

1. Success, thrown exception, failed redirect, recovered dependency, client cancellation, stream completion and two concurrent requests: one canonical summary per request per service and no context leakage.
2. A job retry followed by success: both summaries are retained even at a 0% normal sample rate, distinguished by the queue’s job ID and attempt information, with correct parent correlation. Successful first attempts without another retention reason are sampled out at 0%. Verify the detected library's native attempt numbering and retry evidence. Operational lifecycle records do not inflate counts; recovery retains its appropriate severity and SLO treatment.
3. Repeated query/header values, nested JSON, empty bodies, skipped bodies, response headers and approved previews survive serialization and transport with truthful metadata.
4. Credentials in mixed-case headers, URLs, cookies, arrays, errors, dynamic fields and JSON strings never appear in stdout, exporter buffers, stored fields/raw/message, search indexes, live events, copy/download or exports. Redacted fields remain identifiable by their markers.
5. Verify confirmed cancellation, cancellation merely requested, cancellation before execution, timeout followed by retry, terminal timeout and worker loss. No fabricated attempts, durations or completions; cancellation follows the configured SLO population.
6. Oversized, deep, cyclic and unsupported data produce a bounded safe summary or a counted failure; they never expose unsanitized fallback content or change the application's response.
7. Disconnect/retry/replay, queue pressure, restart, shutdown and failed storage writes have measured outcomes. Use existing transport identity where available; do not deduplicate distinct requests just because their correlation IDs match.
8. SLI fixtures cover duplicates, retries, spans plus logs, failure redirects, exclusions, zero traffic, missing SLI fields, incomplete windows and late arrival. Results match hand-calculated counts.
9. With normal sampling set to 0%, events matching explicit retention conditions, failures and events exactly at or above the configured slow/status boundaries still emit once. With sampling at 100%, every event emits once. All eligible requests contribute to SLI measurements in both cases.

Receiver acceptance, durable storage and visibility in the current filter are different states. Retention expiry and a disk-cap eviction must also be distinguishable from data that never arrived. Report conditions that were not verified.

## 10. Copyable implementation prompt

The prompt is the primary guide deliverable. Its agreed flow is: choose language/framework, configure the service and logging rules, then copy the tailored prompt. Offer editable examples and copyable middleware code alongside it. The stack selection changes syntax and lifecycle hooks while preserving the same behavior.

Use this after reviewing the agreed shape and selecting the target service. The prompt requires no additional envelope or capture metadata.

### Your SLOs and emission rules

Fill this in, or select a guide example and edit it before copying the prompt. These are prompt inputs, not a new quiet configuration-file format.

```text
Language / framework and version:
Job / queue / scheduler systems: detect from codebase (optional user override)
Job SLO measurement, if applicable: queue wait, execution or total elapsed; per attempt or per logical job
Service / environment:
Routes or operations covered:
Eligible requests and exclusions:
Success definition:
Availability target and window (or not configured):
Latency target, threshold and window (or not configured):
SLO-derived retention rules: generated from the definitions above for review
Additional business retention conditions (optional):
Without a latency SLO, slow-request threshold (optional):
Normal-request sample rate: ___% (100% keeps all)
Body capture: disabled, or approved routes/fields per request and response
Additional redaction fields:
Maximum captured body: 8192 bytes (editable)
Maximum complete event: 32768 bytes (editable)
```

**Example: general API**

```text
Service / environment: orders-api / production
Routes or operations covered: POST /orders
Eligible requests and exclusions: every request to this route; no exclusions
Success definition: HTTP 201, no recorded error, response completed
Availability target: 99.9% over rolling 30 days
Latency target: 99% of eligible requests succeed in < 500 ms over rolling 30 days
Derived retention: every eligible request that is not a completed HTTP 201
  without a recorded error, or has duration >= 500 ms
Also retain recorded errors and HTTP status >= 400
Normal-request sample rate: 10%
```

**Example: keep every request while setting up**

```text
Service / environment: my-api / staging
Routes or operations covered: all HTTP routes
Availability target: not configured
Latency target: not configured
Normal-request sample rate: 100%
```

Both examples keep events matching explicit retention conditions, recorded errors and HTTP status >= 400. They are editable illustrations, not recommended targets for every service. Generate slow/failure retention rules from the same SLO definitions used for measurement, including route or business scope and exact threshold boundaries. Retain an eligible event that fails any applicable objective's per-request criteria, even when its HTTP status is below 400. Extra diagnostic retention may include events excluded from SLO measurement; it must not change the SLO population. A single bad request is not necessarily an aggregate SLO breach. Sampling percentage is a separate logging setting, not the SLO target or its error budget. With SLOs unconfigured, keep the baseline error/status rules and use only explicitly supplied slow/business rules.

### Instructions included in the copied prompt

Copy these instructions with the completed inputs above and the JSON example from section 6:

> Adapt Boris Tane’s `wideEventMiddleware()` and `shouldSample(event)` from https://loggingsucks.com/ and the `logging-best-practices` skill to this codebase. Read the source examples and inspect the installed framework and logger first. Preserve attribution, direct event enrichment and one startup logger. Use a plugin for Elysia and idiomatic middleware elsewhere. Do not introduce a recorder class or custom helper API.

> Detect the user's job/queue/scheduler systems and installed versions from dependencies and usage. Adapt to each system's native producer/worker hooks, identity, attempt numbering, parent links and lifecycle evidence; do not assume a particular library or require the user to choose one when the code is clear. Reuse existing conventions and explain the mapping to quiet's job rows and attempts. Distinguish execution time, queue wait and total elapsed time using available measurements and documented boundaries. The job row labels execution time; wait and total belong in expanded details. Apply the user's SLO to the chosen measurement and population, retaining breaches even when execution is fast. Skip this work if there are no jobs. Ask only about unresolved choices, including missing job SLO scope. Missing state or timing remains unknown. Map cancellation only from confirmed queue evidence. Preserve timed-out attempt errors and use confirmed retry/terminal state. A vanished worker does not justify a fabricated completion record. Pre-execution cancellation uses lifecycle evidence without an invented attempt or duration; apply the user’s SLO cancellation rules.

> Create one request-local event, let handlers assign business fields directly, then finalize once at completion. Use top-level `timestamp`, `level`, `service`, `env`, `request_id`, `method`, `path`, `status_code` and `duration_ms`. Business fields such as `flow`, `user` and `order` also sit at the top level. Group headers, parameters/query and optional bodies under `request`/`response`. Handlers assign handled failures to `event.error`; capture unhandled errors automatically. Preserve custom error fields and JSON types; normalize a string error to `{ message }`. Omit absent fields. Add no context wrapper, outcome, calls list or extra schema/provenance envelope.

> Derive `shouldSample(event)` from the supplied SLO scope, success criteria and exact latency boundaries. Keep events failing any applicable objective’s per-request criteria, recorded errors, HTTP >=400 and explicit business retention conditions. Always retain failed job attempts and confirmed successful completion after a retry, using the queue's native retry history. Successful first attempts use normal sampling unless another retention rule applies. Recovery retention does not change severity or SLO classification. Sample only the rest at the supplied rate; default to 100%. The rate is independent of SLO targets. Measure every eligible request or job unit before sampling; extra retention does not change eligibility. Do not invent SLOs or activate guide examples automatically. Ask for missing criteria only when needed; “not configured” is valid.

> Capture approved metadata; bodies are off by default and opt in per route/direction. Use `body_capture: "disabled"` or `"truncated"` when applicable. Redact credentials and configured sensitive fields throughout the event before any sink, using `[REDACTED]`. Email and phone/MSISDN stay visible unless explicitly configured otherwise. Enforce the supplied body/event byte limits after redaction, preserving valid JSON. Skip files and streaming bodies.

> Configure service/environment once. Generate or validate and propagate request IDs only to trusted destinations. Use a UTC completion timestamp, monotonic duration and actual HTTP status. Assign error for recorded errors or HTTP >=400; otherwise warn for slow completed successes and info for normal completed successes. Preserve ordinary log levels; add no Success level. Account for streaming completion, cancellation and framework-handled errors without inferring success or changing application behavior on logging failure. Reuse existing job metadata for job attempts; omit HTTP fields from jobs.

> Verify concurrency isolation, completion once, errors, redaction, byte limits, SLO scope and sampling boundaries through the actual logging path. Show handler examples, resulting JSON and retention/SLO treatment. Report failed or unverified checks. Keep app/UI changes outside this producer task.

In quiet's future Guide, this common brief and the language recipes should come from one source, with the same schema examples and completion checklist. Do not maintain a conflicting second contract in UI copy.
