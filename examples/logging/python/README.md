# Python wide-event reference

Copyable ASGI middleware and an async worker adaptation, using only Python 3.10+
standard-library modules. This is teaching code, not a quiet SDK. A request-local
dictionary, direct handler enrichment, and completion-time `should_sample` follow
Boris Tane's [wide-event middleware and sampling examples](https://loggingsucks.com/#implementing-wide-events)
and the installed MIT `logging-best-practices` skill,
[especially its structure rules](https://github.com/boristane/agent-skills/blob/main/skills/logging-best-practices/rules/structure.md).
Attribution: Boris Tane / boristane. The worker wrapper, capture/redaction limits,
configurable SLO callbacks, and `warn` for slow successful work are our adaptations.
The author did not supply this worker integration. `flow` and business objects
live at top level; there is no recorder, context envelope, outcome, or calls list.

## Run and check

From the repository root:

```sh
python3 -B examples/logging/python/demo.py
python3 -B -m unittest discover -s examples/logging/python -v
```

The demo emits three JSON lines: an HTTP response, its explicitly correlated job,
and an independent job. It uses a minimal ASGI app without a web server. The core
tests use `unittest.IsolatedAsyncioTestCase`; the two optional real-Starlette tests
skip when Starlette is absent. No global packages are required.

To run every check against a pinned framework in an isolated temporary environment:

```sh
python3 -m venv /tmp/quiet-python-asgi-check
/tmp/quiet-python-asgi-check/bin/python -m pip install --no-deps -r examples/logging/python/requirements-framework-check.txt
/tmp/quiet-python-asgi-check/bin/python -m pip check
/tmp/quiet-python-asgi-check/bin/python -B -m unittest discover -s examples/logging/python -v
```

The optional check dependencies are fully pinned, including transitive dependencies;
they are not runtime dependencies. Checked with Python 3.14.8 and Starlette 0.50.0.
The tests exercise local ASGI messages, not a live network socket or FastAPI itself.

## HTTP integration and enrichment

Create one `LoggingConfig` at startup with a JSON-line `sink`, service, and env.
The demo uses `print`; an existing JSON logging setup can accept the serialized
line directly. Avoid encoding it again as an opaque JSON string. Keep the sink
nonblocking (for example, an existing bounded exporter queue); this example does
not create a logger or queue per request.

```python
from wide_events import LoggingConfig, wide_event_middleware

config = LoggingConfig(service="orders", env="production", sink=existing_json_sink)
app = wide_event_middleware(framework_app, config)

# Inside a bare ASGI handler, or request.scope in Starlette/FastAPI:
event = scope["wide_event"]
event["flow"] = "create_order"
event["order"] = {"id": "ord_123", "item_count": 2}
event["user"] = {"email": "visible@example.test", "msisdn": "2335550100"}
# Handled failures may set event["error"] to a dict, native exception, or string.
```

Wrap the complete Starlette/FastAPI application **outside** its error-to-response
middleware, rather than registering the wrapper in its internal middleware list.
Starlette generates 500 responses in outer `ServerErrorMiddleware` and rethrows
errors. This placement observes that response while preserving the exception for
the server. See [Starlette middleware](https://starlette.dev/middleware/) and
[error handling](https://starlette.dev/exceptions/). With a bare app that raises
before sending any response, status is absent: a server-generated response outside
this wrapper cannot be observed and no 500 is invented.

The wrapper writes `x-request-id` to a copy of the outgoing response-start message
before committing headers. Incoming IDs are ignored by default. Set
`trust_request_id=True` only behind a trusted ingress that removes client-supplied
IDs. Accepted IDs match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`; malformed or duplicate
IDs get a fresh UUID. Do not overwrite middleware-owned core fields. The wrapper
restores IDs, service/env, method, status and timing at finalization.

Each invocation has its own dictionary, including a deep copy of JSON-shaped
deployment metadata. Application tasks can enrich it before
the ASGI call returns; coordinate concurrent mutations in your code. Finalization
makes a separate sanitized snapshot, so later mutations cannot change emitted
JSON. Work outliving the ASGI call needs its own job/event and explicit correlation.
This example does not intercept HTTP clients or queue producers: forward the
validated ID only through your owned service/queue adapters (see the demo).

## Completion boundaries

The [ASGI HTTP specification](https://asgi.readthedocs.io/en/stable/specs/www.html)
defines response completion at the final body send, or final trailers when
promised. The wrapper observes these only after `send` returns, includes streaming
time, and freezes monotonic duration and UTC timestamp at the first terminal
signal. This is local send-buffer completion, never proof the client received it.

Emission runs once when the ASGI invocation exits, including exception and
`asyncio.CancelledError` paths. Deferring emission lets it include framework
rethrows and errors after response completion without replacing the actual
already-sent status or extending response latency. For example, a background
failure may produce status 200 with an error; applications whose SLO excludes
background work must account for that distinction in their callback. Keep
background jobs in the worker lifecycle when they need independent measurement.
An app that never returns after finishing a response delays this summary; use a
separate lifecycle adapter for that behavior.

Early `http.disconnect`, a failing `send` (including an OSError caught by the app),
and an app returning without a final body are not inferred successful. Unfinished
responses without a recorded exception get `ResponseIncomplete`, without a fake
499/500. Disconnects received after completion do not reverse it. Older servers
may not raise on closed sends; a receive wrapper can observe only receives the
application actually requests. No receive pump, body buffering or disconnect
polling is introduced. Non-HTTP scopes pass through; WebSocket/upgraded protocols,
server-specific sendfile extensions, indefinite streams, and WSGI are outside
this adapter's completion contract. Unknown boundaries stay incomplete, not
assumed delivered. Process termination can prevent the finalizer entirely.

## Capture and redaction

Headers are allowlisted (`content-type` only by default); repeated values remain
arrays. `query_fields` and `param_fields` explicitly approve names. Query capture
is skipped above 8,192 raw bytes or 128 parsed fields. OAuth query `code`/`state`
are always masked. Matched `request.route` is included when the framework supplies
`scope["route"].path`; bare Starlette does not always do so. Missing route/params
remain unknown. Paths exclude query/fragment. Configure `path_projector` for
secret-bearing path segments, returning a safe template or `None` to omit the path.

Bodies are off by default, independently per direction. Enable an exact ASGI path,
approved JSON fields, and provide already-parsed application data or a deliberate
response projection in request scope:

```python
config.body_fields = {
    "/orders": {"request": ("item_count", "currency"), "response": ("order_id",)}
}
# Handler, after normal application parsing/validation:
scope["wide_event_bodies"]["request"] = parsed_json
scope["wide_event_bodies"]["response"] = response_projection
```

The middleware selects the approved fields automatically without reading any
body bytes for logging. Enable this only on bounded JSON routes; nested selected
objects must themselves be deliberate safe projections. The corresponding wire
content type must be `application/json`. Chunked/streaming bodies observed through
`more_body`, files, multipart and missing projections are skipped. Enabled-but-
skipped capture has neither a body nor a marker; disabled capture has
`body_capture: disabled`. A shortened projection has `body_capture: truncated`.
No captured value changes the actual input, response bytes or headers.

Redaction applies recursively across business fields, HTTP groups, projections
and errors before the sink. Built-ins cover credentials, auth/cookies, password,
API keys, access/refresh/ID tokens and payment credentials. Keys ignore case and
separators (`Refresh-Token`, `refresh_token`, `refreshToken`). Extend protection
with `sensitive_names=("national_id", "email")`; built-ins remain active. Email and
phone/MSISDN remain visible by default. Repeated secret header/query values remain
arrays of `[REDACTED]`.

Key masking cannot discover secrets embedded in free text, URLs, SQL, encoded
JSON, arbitrary field names or object keys. Do not approve those contents without
a safe projection or application-specific `text_scrubber(string) -> string`.
In particular, response `location` and secret-bearing URLs need an explicit value
policy before being allowlisted. The scrubber applies to string values, not keys;
use controlled schema keys. Native exception messages/custom fields are preserved
and need that same text policy. Unknown Python objects are omitted rather than
stringified. There is no claim that this detects every secret.

## Bounds, sampling and SLO measurements

Defaults are 8,192 serialized UTF-8 bytes per body and 32,768 per event, configurable
with `body_bytes` and `event_bytes`. Output is single-line valid JSON; ASCII escaping
keeps even lone-surrogate input valid UTF-8. Shortening changes JSON values, not
serialized bytes. Structural safety caps are depth 8, 64 entries per container,
1,024 visited values per sanitization budget, 4,096 characters per text value and
128 per key. Strings over the character limit are omitted before text scrubbing,
so a partial secret cannot escape a scrubber that matches its full value.
Core fields, business context and HTTP metadata have separate bounded
budgets; body projections have their own. Unsupported/cyclic/deep values use
`[OMITTED]`. More than 64 top-level business entries are not inspected. These
limits can shorten data even when the byte limit has room.

The event limit wins: body previews go first (their truncated markers remain),
then optional metadata/business fields, then nonessential error details. Request
ID, native worker identity fields, status, timing, flow and error identity/message take priority; extreme
path/flow/message values may also be shortened. If a minimal valid event still
cannot fit, no oversized fallback is sent. Fixed-reason `logging_failure` callbacks
report failures without leaking exception representations. Hook/sink failures are
contained; no automatic retry risks a second summary. Sink delivery itself is
outside the producer's guarantee.

`sample_rate=1` keeps everything. At zero, recorded errors, HTTP status >=400,
slow completed successes, user `slo_failure(event)`, `retain(event)`, and confirmed
successful retry recovery still bypass sampling. `slow_ms` uses inclusive `>=`;
an optional `slow(event)` predicate is ORed with it. Neither has an active default.
Error takes precedence over warn; ordinary success is info. An arbitrary nested
business field called `error` is not failure evidence.

`measure(event)` receives a sanitized private copy for each unit before sampling
and final event-budget pruning, including sampled-out successes. It can use actual
HTTP status, business fields or queue timings according to your supplied SLO scope,
eligibility, success and latency criteria. Supply low-cardinality labels; never
use raw paths, IDs or emails as metric labels. Do not calculate SLA/SLI ratios from
the sampled sink. Retention/SLO predicates are synchronous, pure callbacks; if a
predicate throws, the event is kept and a health reason is reported. A throwing
measurement callback reports health and emission continues. Invalid application
data or a failing sanitizer can prevent measurement too; monitor this health path
and ingress/queue metrics independently. There is no built-in SLO target.

## Worker adapter boundary

```python
from wide_events import wide_event_worker

event = {"flow": "fulfill_order"}
result = await wide_event_worker(
    handle_attempt, event, config,
    job_metadata={"job_id": actual_job_id, "attempt": actual_native_attempt},
    confirmed_recovery=lambda: broker_confirmed_success_after_retry,
)

# async def handle_attempt(event):
#     event["order"] = {"id": order_id}
#     ... actual work (and broker completion/ack if this adapter owns it) ...
```

Supply a fresh dictionary per attempt. `job_metadata` contains actual queue facts
and is visible to the handler; no queue library or attempt-index convention is
assumed. Use your queue's existing job/attempt/run/parent fields. Include an
originating `request_id` only if it actually came from the job envelope. Independent
jobs have no invented request ID or HTTP fields. No cancellation, retry scheduling,
terminal queue state, parent relationship or timing is inferred from missing logs.

The wrapper measures **handler execution per attempt** and rethrows errors and
cancellation after one finalization path. Handler success alone is not broker ack
or final queue success. `confirmed_recovery` is an explicit queue-derived boolean
or a synchronous zero-argument callback evaluated after handler success. Set it
true only when the broker has confirmed successful completion after retry; a high
attempt number is insufficient. If ack occurs outside this wrapper, leave the
fact false or adapt the boundary to include broker completion before finalizing.
Future ack cannot change an already-emitted record. If the callback fails, recovery
remains unknown and health is reported. Do not replace it with a guessed success.

All failed attempts are retained, even with retries remaining. Confirmed recovery
is retained at info/warn as appropriate; ordinary first-attempt success samples
normally. Queue-wait and eventual-job SLOs need reliable queue-supplied timings and
separate eventual-completion measurements where applicable. Worker disappearance
or process kill can prevent finalization; no wrapper can promise a record then.
