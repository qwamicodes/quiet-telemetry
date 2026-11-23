# Prompt: set up canonical completion events for quiet

Copy everything below the line into your coding agent (Claude Code, Cursor, Codex…), at the root of the repo you want quiet to read. The full contract is in `docs/logging-guide.md`; this is the copyable brief.

---

You are adding canonical logging to this codebase so that **quiet** (a self-hosted log viewer) can stream it, search it and stitch every request and background job into one flow. quiet reads any JSON line from stdout (Docker), Vector, Fluent Bit, OTLP or HTTP, and joins records that share ids (`request_id`, `job_id`, `trace_id`), so ids, timing and status must be exact.

## Reviewed inputs
Language/framework: detect from the codebase; detect installed versions
Service/environment: detect from the codebase
Queue: inspect the codebase; keep each queue's native ids
Goals: none configured. Do not invent targets or activate examples.

Ordinary-completion sample rate: 100% (keep every event)
Additional business retention: none
Headers: approved request/response metadata
Bodies: both disabled; no route opt-ins
Body/event limits: 8192/32768 serialized UTF-8 bytes (measured after redaction)
Redact: passwords, tokens, API keys, authorization, cookies and any configured fields
Keep visible: email, phone/MSISDN

Adapt Boris Tane's `wideEventMiddleware()` and `shouldSample(event)` from https://loggingsucks.com/ and the `logging-best-practices` skill. Read those examples and inspect the installed framework first. Preserve direct enrichment and one startup logger. The capture, redaction, level mapping and sampling rules below are quiet's agreed adaptations.

## Goal
Build one canonical completion event per request, job attempt or scheduled run, and emit it once when the work ends (after the sampling decision). Middleware owns the event, timing and emission; handlers enrich the shared event directly with `flow` and business fields. Include the actual status, a monotonic duration and structured errors. Do not introduce a calls list, an `outcome` field, a context wrapper, a recorder class or a custom logging SDK.

## Before you change anything
1. Find the logger in use (pino, winston, bunyan, structlog, zap, slog, tracing…). Keep it; configure it to emit JSON to stdout. Don't add a second logger.
2. Detect the actual HTTP framework, job/queue/scheduler systems (BullMQ, Sidekiq, Celery, Asynq, River…) and their installed versions, plus outgoing clients. Preserve their native ids and lifecycle semantics. Skip job work if there are no jobs.
3. Include every selected goal separately, preserving its product template, name, target, period, scope, timing and success rules. Read `docs/logging-product-templates.md` when available. Map workflow names to actual services, routes and events in the codebase; resolve ambiguous mappings instead of inventing them. Goals may be empty.
4. Report the plan in 5–10 bullets, including how each queue's ids, attempts and completion map to quiet, then implement. Ask only about choices the code can't settle.

## The line shape
One JSON object per event; add business fields directly at the top level:

```json
{
  "timestamp": "2026-10-21T14:07:31.123Z",
  "level": "error",
  "service": "legivent-api",
  "env": "production",
  "version": "1.42.0",
  "commit_sha": "a1b2c3d",
  "flow": "create_order",
  "request_id": "req_8f2a7d",
  "method": "POST",
  "path": "/api/v1/orders",
  "status_code": 500,
  "duration_ms": 3412,
  "user": { "id": "usr_77b2e1" },
  "order": { "id": "ord_1182" },
  "request": {
    "route": "/api/v1/orders",
    "headers": { "authorization": "[REDACTED]", "content-type": "application/json" },
    "body_capture": "disabled"
  },
  "response": { "headers": {}, "body_capture": "disabled" },
  "error": {
    "name": "OrderError",
    "code": "ORDER_CREATE_FAILED",
    "message": "inventory unavailable",
    "reason": "dependency_failure",
    "details": { "dependency": "inventory" }
  }
}
```

Rules:
- **Time:** one UTC completion `timestamp`. Measure `duration_ms` with a monotonic clock; handle failures and interrupted responses. Never two time keys.
- **Levels:** debug, info, warn, error. A recorded error or HTTP ≥400 is `error`; a completed success at or over the slow threshold is `warn`; any other completed success is `info`. Error wins over slowness. Trace maps to debug, fatal to error. There is no success level. A failed sign-in that redirects keeps `status_code: 302` and its `error`.
- **Identity:** `service`, `env` and `version` or `commit_sha`, set once in the logger base. Preserve native request and job identifiers.
- **flow:** the short business name, such as `create_order`. It is a direct event field and labels the row in quiet's stream; it is not a correlation id.
- **HTTP:** `method`, sanitized `path` (no query or fragment), actual `status_code` and `duration_ms` at the top level. `request` holds approved `headers`, `params`, `query`, `route` and an optional `body`; `response` holds approved `headers` and an optional `body`. Don't repeat the top-level HTTP fields inside them. Don't invent a 499/500 when no response was sent.
- **Errors:** an object. Normalize a plain string to `{ "message": … }`. Keep `reason`, `details` and other safe fields in their original JSON types (string, object, array or scalar). Never put stringified JSON in `message`.
- **Enrich directly:** `event.user = { … }`, `event.order = { … }`. Omit absent fields instead of writing `null`. "Context" is only a group in quiet's field card, not a JSON wrapper.
- **Bodies:** off by default; opt in per route and direction with safe projections. Skip files and streams. Mark `body_capture: "disabled"` or `"truncated"`. A missing body with no marker means unknown, never empty. Enforce the body and event limits after redaction and keep valid JSON and the core fields; if a safe event can't fit, report a payload-free drop.
- **Redaction:** replace credentials and configured fields with `[REDACTED]` recursively across headers, bodies, business data and errors before any sink. Use safe projections or a text scrubber for prose and URLs; key matching can't catch every secret. quiet's own ingestion redaction is a second line of defence, not a replacement.
- **No duplication:** don't log a full provider payload and flattened copies of it.

## Ids (this is what makes flows work)
- **request_id:** accept an incoming `x-request-id` only from trusted upstreams, otherwise generate one. Keep it request-local and return it as the `x-request-id` response header.
- Propagate `request_id` through your own clients and queue adapters to trusted services only. Preserve existing `trace_id` / `span_id` when instrumentation provides them.
- **Jobs:** propagate `request_id` into job data when a request enqueues the job. Log the queue's own id as `job_id` (`payout-88-1300`) with its `queue` and `service`; bare ids can repeat across queues. Standalone jobs need no invented request.
- **Workers:** one completion event per attempt with the queue's own attempt number. Only queue evidence establishes retries, cancellation, terminal completion or child links; missing completion stays unknown. Measure execution, queue wait and total time separately where available. Omit HTTP fields from jobs.
- Matching ids alone don't prove causality; never invent a parent-child execution chain.

## Where to write the canonical line
- **HTTP:** middleware owns the event, timing, completion and emission. Handlers add business context directly. Finalize once at the framework's real completion boundary, including thrown errors, aborts and streamed responses.
- **Jobs:** wrap the processor; measure and finalize each attempt once. Preserve native acknowledgements, retry behaviour and application exceptions.
- **Cron / scripts:** same wrapper, one event per run.
- A logging failure must never change the application's result.

## Sampling
Implement `shouldSample(event)`. Always keep recorded errors, HTTP ≥400, slow successes, failed job attempts, confirmed recovery after a retry, events that miss a configured goal and explicit business retention rules. Sample only the rest at the routine rate (100% unless the user set another). Measure every eligible request or job for SLOs before sampling; retention never changes who counts. A single bad event is not an SLO breach.

## Done when
- Each request, job attempt or run builds one completion event, and retained events emit once. Related records carry the correct scoped ids.
- Exceptions and interrupted work still produce the event with the actual status and a structured `error` when present.
- Tests cover the middleware and the job wrapper: every configured goal and its exact timing boundary, success, error, abort and stream paths, concurrency isolation, typed errors, redaction, byte limits, sampling and retries.
- A short `docs/logging.md` explains enrichment, capture, redaction, SLO inputs, sampling and how to add fields.

Show one example event for a successful request, a failed request and a job retry when you're done, and report any check you couldn't verify.
