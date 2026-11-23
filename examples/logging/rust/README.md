# Rust wide-event reference

Standalone Axum 0.8.9 / Tower example, independent of quiet's server crate. Adapted
from Boris Tane's [wideEventMiddleware and shouldSample](https://loggingsucks.com/#implementing-wide-events)
and his MIT-declared [logging-best-practices skill](https://github.com/boristane/agent-skills/tree/main/skills/logging-best-practices),
especially [rules/structure.md](https://github.com/boristane/agent-skills/blob/main/skills/logging-best-practices/rules/structure.md).
The worker adapter is **our adaptation**, not author-provided queue code. Slow-success
`warn`, completion hooks, redaction, bounded capture and retention are the agreed
quiet adaptations described in [the logging guide](../../../docs/logging-guide.md).

Run from this directory (tested using Rust/Cargo 1.99):

```sh
cargo run --locked
curl -i http://127.0.0.1:3000/ready
curl -i -H 'content-type: application/json' \
  -d '{"item_count":2,"currency":"GHS","password":"synthetic-secret"}' \
  http://127.0.0.1:3000/orders
curl -i http://127.0.0.1:3000/failed-redirect
```

One JSON-lines sink is configured at startup. A `/orders` completion has this shape
(IDs and timing vary); passwords and unapproved input are absent from the projection:

```json
{"timestamp":"2026-11-17T14:00:00.000Z","level":"info","service":"orders-example","env":"development","request_id":"b2f83c16-1978-4eae-8826-2b0b0911b9fe","method":"POST","path":"/orders","status_code":201,"duration_ms":1.2,"flow":"create_order","order":{"id":"ord_example"},"request":{"headers":{"content-type":"application/json"},"route":"/orders","body":{"item_count":2,"currency":"GHS"}},"response":{"headers":{"content-type":"application/json"},"body":{"order_id":"ord_example"}}}
```

`SAMPLE_RATE=0 cargo run --locked` samples out ordinary successes while retaining the
handled redirect error with its actual 307 status and `error` level. Normal sampling
defaults to 1; no slow threshold, SLO target or business retention rule is activated
by default. Stop the demo with Ctrl-C; graceful shutdown waits for active requests.

```sh
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

## Direct enrichment and capture

`Extension<SharedEvent>` is exactly `Arc<Mutex<Map<String, Value>>>`. Lock only while
assigning safe business fields; release the lock before awaiting or starting any
operation that might finalize the request. Finalization moves the map into a stable
snapshot. Later writes cannot alter the emitted line. Adapter-owned HTTP metadata
overrides handler assignments; handlers may set a top-level structured `error` for
handled failures. There is no recorder class or context wrapper.

```rust,ignore
async fn handler(Extension(event): Extension<SharedEvent>) -> &'static str {
    event.lock().unwrap().insert("flow".into(), json!("create_order"));
    event.lock().unwrap().insert("order".into(), json!({"id": "ord_example"}));
    "accepted"
}
```

`HttpConfig.capture` opts in by matched route template, separately for request and
response field allowlists. Default bodies have `body_capture: "disabled"`. Supply
already-parsed JSON in `Extension<Arc<Mutex<Projections>>>`; deliberate response JSON
can instead be placed in response extensions, as in `src/main.rs`. The adapter picks
approved fields automatically and bounds the copy. It never polls a request body,
buffers a response for logging, or changes application payloads while redacting.
Use small deliberate projections instead of cloning large parsed application trees.

Capture requires a JSON content type. Responses also require a known exact body
length. Files, SSE, unknown-length streams, unsupported data and missing projections
are skipped; enabled-but-skipped capture has neither `body` nor a disabled marker.
Do not attach body projections to files or streams even if a custom body reports a
known length: an erased Axum `Body` cannot identify every concrete producer. Only
attach these projections at an already-parsed, non-streaming JSON boundary.

`query` and `params` are also explicit projections with route-specific allowlists.
Provide approved values from the application's parser, using strings or arrays of
strings so repeated query values survive. The middleware does not parse/copy raw
queries. Configured header names are case insensitive, emitted lowercase, with arrays
for repeated values. Credentials become markers even if mistakenly allowlisted;
OAuth `code`/`state` in HTTP projections are masked. Empty query/params are omitted.

The default path policy uses only `Uri::path()`, never its query. Configure
`HttpConfig.path` to replace secret-bearing segments or return `None` to omit an
unsafe path. Header `location` and URL/URI fields are masked wholesale. Key-based
redaction cannot identify arbitrary secrets in path segments, field names, free-text
messages, SQL, binary data or encoded strings. Use static field names and controlled
summaries. Do not copy SQL parameters, file contents or connection strings.

## Sampling, measurements and errors

Call `Config::validate` once, then share immutable configuration. Configure `service`,
`env`, optional deployment fields, the JSON sink, `sample_rate`, optional `slow_ms`
(inclusive `>=`), a pure `slow` predicate, `slo_failure`, and `retain` there. SLO
predicates must use the user's actual population, success definition and threshold;
one failed request criterion is not an aggregate SLO breach. No SLO is inferred.

`measure(event, Completion)` runs once before diagnostic sampling, including at
zero rate, and before final event-budget pruning. It sees sanitized, bounded data.
Use service/env, controlled flow and route templates as metric dimensions; never
request/user/job IDs or arbitrary paths. Record eligibility and exclusions there,
using the same objective criteria as `slo_failure`. Incomplete HTTP bodies are not
successful. Worker `Completion.successful` describes the **local handler result**;
`confirmed_retry_completion` additionally requires supplied queue evidence. Do not
compute SLAs or error ratios from sampled lines. Bodies and arbitrary large context
may be shortened; SLO criteria should depend on deliberate bounded scalar facts.
If sanitization fails, the measurement still runs with typed minimal facts and
`Completion.context_available: false`; count it as unclassified coverage, never a
scoped SLO success. The unsanitized payload is neither measured nor emitted.

Errors/status >=400 take `error` priority, then completed slow successes use `warn`,
otherwise `info`. Nested business properties named `error` do not imply failure.
`should_sample` retains recorded errors/status >=400, completed slow successes,
applicable SLO failures, configured retention and confirmed retry completion even at
zero rate. Everything else uses the configured random rate.

`error_json` extracts a native Rust error's Display message/type plus explicit custom
JSON fields. A queue/framework adapter supplies custom fields because `std::error::Error`
has no reflective field access. A plain string error becomes `{ "message": ... }`.
Panic payloads/Debug representations are never used as logging fallbacks. Framework
errors already converted into responses retain their actual status; Axum does not
expose their original native error to outer middleware. Map such errors inside the
handler/error-mapping layer and assign structured details to the event there.

Redaction is recursive, case insensitive and separator normalized, across errors,
business data and HTTP groups. Built-in credential rules cannot be disabled by custom
rules. `sensitive_fields` adds names; email and phone/MSISDN remain visible by default.
JSON-looking string values and obvious absolute URLs are omitted instead of parsed;
use real JSON values for structure. Optional `text_policy` scrubs or rejects remaining
strings, including messages/stacks. It receives at most 4096 UTF-8 bytes per string;
longer strings are omitted before scrubbing so a partial secret cannot bypass a
policy that matches its full value. Only controlled summaries or an application-specific
policy can make arbitrary text safe. A redaction marker does not certify that all possible secrets were found.

After redaction, defaults are 8192 serialized UTF-8 bytes per body and 32768 per event.
Strings, depth (16), members/elements (64), key length (128 bytes) and traversal
budgets are bounded before copying. `Value` cannot contain cycles or opaque native
objects; convert native inputs explicitly rather than using Debug. Body shortening
keeps valid JSON and marks `body_capture: "truncated"`; ordinary redaction alone
does not mark truncation. The total event cap wins: bodies go first, then optional
context and error detail/stack. Core IDs, flow, status, timing and core error fields
are retained, or emission is rejected if the minimal representation cannot fit.
Oversized correlation/flow identifiers are rejected, not silently rewritten.

Sink errors and unwinding panics in telemetry callbacks are counted in
`logging_failures` and cannot change the application's result. Policy panics retain
conservatively; they do not establish an SLO result. Measurement failures mean
incomplete coverage. A scrubber failure rejects emission safely. Monitor the failure
counter separately; no raw fallback is emitted. Rust's installed panic hook is
independent and still runs on panics, including caught panics; configure that hook's
own output policy in the host application. This example does not replace it.

## HTTP completion boundary

Apply `wide_event_middleware` last/outermost over all routes and status/error-mapping
middleware. It measures with `Instant`, assigns a UTC completion timestamp and sets
`x-request-id` before returning headers. Incoming IDs are regenerated unless explicitly
trusted, unique as a header value, and 1–128 ASCII alphanumeric/`-_.` characters.
Enforce the upstream trust boundary separately. Forward this ID only through the
application's trusted client/job adapters; this demo contains no outbound client.

The wrapper forwards data, errors, trailers and size hints. It finalizes on
`poll_frame(None)`, an end-of-stream hint after the final frame, known empty bodies,
or drop/error; one guard handles all these paths. HEAD/204/304 have no entity body
to observe. `status_code` is the actual selected response status, not proof that
headers reached the socket. Dropping a handler future before a response exists
omits status entirely. A dropped response keeps its selected status and records an error with
`reason: "dropped"`; this proves local interruption, **not** client cancellation.
Successful completions require no extra body-completion fields in the log schema. Native body errors are serialized without
changing the stream's actual error.

This is **local body completion**, not network acknowledgement or client receipt.
It includes streaming time while polling continues. A body left live but never
drained/dropped has no completion event. An unpolled handler future never began work
and produces no event. WebSocket/101 and successful CONNECT upgrades are unsupported:
the handshake event records an error with `reason: "unsupported_upgrade"`; the upgraded connection is not instrumented. Add a protocol-specific
adapter instead of treating its handshake as successful stream completion.
Lifecycle references: [Axum middleware](https://docs.rs/axum/0.8.9/axum/middleware/index.html)
and the [http-body Body contract](https://docs.rs/http-body/1.1.0/http_body/trait.Body.html).

## Queue adapter boundary

`wide_event_worker(&mut Event, QueueFacts, config, handler, confirm)` takes a mutable
event and native metadata supplied by the caller. The demo's CLI accepts metadata
JSON and an optional explicit confirmation flag:

```sh
cargo run --locked -- worker '{"job_id":"fixture:delivery","attempt":"native-first"}'
SAMPLE_RATE=0 cargo run --locked -- worker \
  '{"job_id":"fixture:delivery","attempt":"native-retry","request_id":"originating-request"}' \
  confirmed-success-after-retry
```

These are **synthetic fixtures**, not actual broker observations. A real adapter must
populate `QueueFacts.metadata` from its installed queue: identity, native attempt/run
token, confirmed parent links, retry scheduling and reliable wait/total timings only
when available. No queue is selected or installed. No attempt numbering is assumed.
Independent jobs omit `request_id`; related work copies it explicitly through the
job envelope. Handler assignments cannot replace queue-supplied facts. No HTTP
metadata is generated for jobs.

The confirmation callback runs **after** handler return and may await the actual
broker completion/ack boundary. Return `QueueCompletion::Unknown` when it cannot be
established. `Successful { after_retry: true }` requires both real completion evidence
and the queue's native retry history; a high attempt number or handler return alone
is insufficient. An errored attempt never becomes recovered merely because a callback
claims success. If the broker acknowledges outside this wrapper, integrate with its
completion hook instead of guessing inside `confirm`.

`duration_ms` is execution from wrapper entry through handler return, excluding the
confirmation callback; the timestamp is finalization time. If interrupted during
execution, timing ends at drop. Known queue-wait/total timings remain independent
native metadata. An SLO can retain a fast attempt because of its supplied queue wait.
First successes remain sampled; confirmed recoveries retain their normal info/warn
severity. `Attempt` drop emits one local interruption error when possible; it never
claims a queue Cancelled/Failed/Retry scheduled/Completed state. Queue-confirmed
cancellation, pre-execution cancellation, timeouts, scheduling, child relationships
and terminal state mapping need the actual queue's lifecycle hooks.

Process kill, `panic=abort`, OOM or machine failure can prevent finalization. There is
no durable exporter, broker implementation, ingestion/storage verification, SLO
aggregate store or delivery guarantee here. The tests exercise Axum/Tower through
actual response bodies and the worker adapter; they do not prove socket disconnect
propagation, client receipt or any particular queue's acknowledgement behavior.
