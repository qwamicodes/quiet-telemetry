# Prompt: set up canonical logs with wide events for quiet

Copy everything below the line into your coding agent (Claude Code, Cursor, Codex…), at the root of the repo you want quiet to read.

---

You are adding canonical, wide-event logging to this codebase so that **quiet** (a realtime log viewer) can stream it, search it, and stitch every request and background job into one flow. quiet reads any JSON line from stdout (Docker), Vector, Fluent Bit, OTLP or HTTP. It builds flows by joining lines that share ids (`request_id`, `job_id`, `trace_id`), so ids and timing must be exact.

## Goal
Exactly **one canonical log line per unit of work**: one per HTTP request, one per job attempt, one per scheduled run. That line is written when the work ends and carries everything needed to understand it (who, what, outcome, timing, errors, and a `wideEvents` bag of context). Keep incidental logs to a minimum; don't scatter `console.log` through handlers.

## Before you change anything
1. Find the logger in use (pino, winston, bunyan, structlog, zap, slog, tracing…). Keep it; configure it to emit JSON to stdout. Don't add a second logger.
2. Find the HTTP framework, the job/queue library (BullMQ, Sidekiq, Celery, …), and every outgoing HTTP client.
3. Report the plan in 5–10 bullets, then implement.

## The line shape
Every line is one JSON object with snake_case keys:

```json
{
  "time": 1761148051123,
  "level": "error",
  "service": "legivent-api",
  "env": "production",
  "version": "1.42.0",
  "commit_sha": "a1b2c3d",
  "msg": "build_report",
  "request_id": "req_8f2a7d",
  "job_id": null,
  "method": "GET",
  "path": "/api/v1/reports/1182",
  "route": "/api/v1/reports/:id",
  "status": 500,
  "duration_ms": 3412,
  "outcome": "failed",
  "user_id": "usr_77b2e1",
  "error": { "name": "ReportError", "code": "REPORT_BUILD_FAILED", "message": "renderer timed out", "details": { "renderer": "pdf" }, "stack": "…" },
  "wideEvents": {
    "calls": [
      { "provider": "postgres", "action": "load_report", "at_ms": 12, "duration_ms": 40, "ok": true },
      { "provider": "renderer", "action": "render_pdf", "at_ms": 60, "duration_ms": 3300, "ok": false, "status": 504 }
    ],
    "report_id": 1182
  }
}
```

Rules:
- **Time:** one timestamp only, either `time` (epoch ms) or `timestamp` (ISO 8601). Never both, never duplicated.
- **Level:** `debug`, `info`, `warn`, `error` (pino numeric levels are fine). 5xx = error, slow or 4xx you care about = warn.
- **Identity:** `service`, `env`, `version` or `commit_sha` on every line (set once in the logger base).
- **msg:** a short snake_case event name (`create_payout`, `charge_card`), not a sentence.
- **Outcome at the top level:** `status`, `duration_ms`, `outcome` (`ok` | `failed` | `retry`).
- **Errors** as an object: `error: { name, code, message, details, stack }`. `details` is an object, never stringified JSON.
- **wideEvents** is the bag for everything else about this unit of work. `wideEvents.calls` lists child actions (DB, providers, other services) with `at_ms` = ms since the unit started and optional `duration_ms`, `ok`, `status`. quiet draws these as child steps with their own time bars.
- No duplication: don't log a full provider payload *and* flattened copies of it. Keep the flattened fields.
- PII: no full names, phone numbers, emails, card data, tokens or passwords. Use ids.

## Ids (this is what makes flows work)
- **request_id:** generate at the edge (or accept an incoming `x-request-id`), store it in request-scoped context (AsyncLocalStorage, contextvars, …), put it on every line for that request, and return it as the `x-request-id` response header.
- **Outgoing HTTP to your own services:** forward `x-request-id`. The receiving service reuses it.
- **Jobs:** when a request enqueues a job, put `request_id` into the job data. Every job line carries `job_id` **and** the parent `request_id`. Make `job_id` globally unique, e.g. `<queue>:<entity>:<n>` (`payout:88:1300`), never a bare number shared by several queues. BullMQ rejects custom `jobId`s containing `:`, so use `payout-88-1300` as BullMQ's id and log `job_id` as `payout:88:1300`.
- **Job lifecycle:** one line per event with the same `job_id`: `picked_up`, `attempt_failed` (+ `retry_attempt`, `next_retry_in_ms`), `completed` or `moved_to_failed`. Jobs that enqueue jobs pass the same `request_id` down.
- **trace_id / span_id:** only if the app already uses OpenTelemetry; then include both on every line.

## Where to write the canonical line
- **HTTP:** one middleware that starts a timer and context on entry, lets handlers add fields (`ctx.log.set({ user_id, report_id })`, `ctx.log.call({...})`), and writes the single line in a `finally` / on response finish, including on thrown errors and aborted requests.
- **Jobs:** wrap the processor the same way; one line per attempt plus the lifecycle lines.
- **Cron / scripts:** same wrapper, one line per run.

## Sampling
Send everything to quiet (it keeps a rolling window). If the app also ships to a paid backend, sample there only, and always keep errors and slow requests (`should_sample`, `sample_reason`).

## Done when
- One request produces exactly one canonical line, and the job it enqueues produces lines carrying the same `request_id`.
- A thrown error still produces the canonical line with `status`, `outcome: "failed"` and a structured `error`.
- Tests cover the middleware (one line, ids present, error path) and the job wrapper.
- A short `docs/logging.md` explains how to add fields and calls.

Show me one example line for a successful request, a failed request, and a job retry when you're done.
