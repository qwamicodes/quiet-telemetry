# Go wide-event reference

Copyable `net/http` middleware and a worker-boundary adaptation, using only the
standard library. This standalone module does not change quiet's runtime.
Requires Go 1.23+ (`Request.Pattern` in the demo); verified with Go 1.27.4.

Adapted from Boris Tane's [wideEventMiddleware and shouldSample reference](https://loggingsucks.com/#implementing-wide-events)
and the MIT [logging-best-practices skill](https://github.com/boristane/agent-skills/tree/main/skills/logging-best-practices),
especially [`rules/structure.md`](https://github.com/boristane/agent-skills/blob/main/skills/logging-best-practices/rules/structure.md). Direct map enrichment and one startup logger
follow that reference. Workers, safe capture, byte limits, user SLO callbacks,
`warn` for configured slow successes, and the lifecycle details here are our
adaptations. The article's sample rates, business rules and latency threshold are
not defaults in this module. No recorder API or new event envelope is involved.

## Run and check

From this directory:

```sh
go test ./...
go test -race ./...
go vet ./...
go run ./cmd/demo -mode worker -sample-rate 0
go run ./cmd/demo -mode http -addr 127.0.0.1:8080
```

The worker command emits two JSON lines (failed attempt and confirmed recovery),
with `observations=3 logging_failures=0` on stderr. Its first ordinary success is
sampled out. IDs and attempt labels are explicit synthetic fixture facts.

With the HTTP demo running:

```sh
curl -i -H 'Content-Type: application/json' \
  -d '{"item_count":2,"email":"buyer@example.com"}' http://127.0.0.1:8080/orders
curl -i http://127.0.0.1:8080/handled
curl -i http://127.0.0.1:8080/panic
curl -s http://127.0.0.1:8080/measurements
```

The module has no third-party dependencies, so it needs no `go.sum`. If Go is
unavailable, extract an official [Go archive](https://go.dev/dl/) into a temporary
directory, verify the published SHA-256, and use that directory's `bin/go` and
`bin/gofmt`. No global installation is needed.

## Enrich directly

Configure one logger at startup and wrap the entire mux so framework-generated
404/405/error responses are observed too:

```go
logger, err := logging.New(logging.Config{
    Service: "orders-api", Env: "production",
    Sink: logging.JSONLineSink(os.Stdout),
})
if err != nil { panic(err) }

mux := http.NewServeMux()
mux.HandleFunc("POST /orders", func(w http.ResponseWriter, r *http.Request) {
    event := logging.EventFrom(r.Context())
    event["flow"] = "create_order"
    event["order"] = logging.Event{"id": "ord_example"}
    w.WriteHeader(http.StatusCreated)
})
handler := logger.WideEventMiddleware(mux)
```

A representative completion line (IDs, timestamp and duration vary):

```json
{"timestamp":"2026-11-17T14:00:00Z","level":"info","service":"orders-api","env":"production","request_id":"b6064f04461f459a9cda8ad2f9dd5c071","method":"POST","path":"/orders","status_code":201,"duration_ms":0.2,"flow":"create_order","order":{"id":"ord_example"},"request":{"headers":{},"body_capture":"disabled"},"response":{"headers":{},"body_capture":"disabled"}}
```

Record handled failures directly, even when returning a redirect:
`event["error"] = errors.New("identity provider unavailable")`. Plain string
errors become `{ "message": ... }`; native Go errors get `Error()` plus exported
custom fields, respecting JSON field names. Useful nested types survive redaction.
An HTTP 302 with a recorded error remains 302 and has level `error`.

Middleware restores its request ID, method, path, actual status, service, env,
completion timestamp and monotonic duration at completion. Business code must
not overwrite these or the owned request/response groups. Each request owns its
map. Join concurrent handler work before returning and synchronize shared map
writes yourself; Go maps are not safe for concurrent writes. Do not retain the
map for asynchronous enrichment after the boundary. Independent child work gets
its own event. Emitted bytes are detached from the mutable map.

Incoming `X-Request-ID` is ignored by default. `TrustRequestID: true` accepts
exactly one value matching `[A-Za-z0-9_-]{1,128}`. Otherwise 16 random bytes produce
a new hex ID. It is returned in the response header. This validates syntax only;
enable trust only behind a trusted ingress. No trace or span IDs are invented.

## HTTP lifecycle and supported writer boundary

See Go's official [Handler](https://pkg.go.dev/net/http#Handler),
[ResponseWriter](https://pkg.go.dev/net/http#ResponseWriter), and
[ResponseController](https://pkg.go.dev/net/http#ResponseController) contracts.

- Exactly one deferred finalization runs when synchronous `ServeHTTP` returns or
  panics. Synchronous streaming time is included. Flushes do not emit additional
  summaries. The fixture uses a real HTTP server for streaming and panic aborts.
- The first final `WriteHeader`, implicit write status, or successful flush owns
  the actual status. Informational 1xx responses do not commit the final status
  (101 is treated as a protocol switch). Duplicate final writes are ignored.
  Empty ordinary responses explicitly commit the usual 200 at handler return.
- A recovered panic before headers generates a real generic HTTP 500. After
  headers, it preserves the sent status and aborts using `http.ErrAbortHandler`;
  it never appends a fake 500 to a partial stream. An incoming `ErrAbortHandler`
  remains an abort. Panic values that are not native errors get a controlled
  message, never a formatted arbitrary panic representation.
- Context cancellation and observed write/flush errors produce errors, preserving
  the status if one was committed. A cancelled or aborted request with no status
  omits `status_code`; it does not invent 499 or 500. Cancellation is the local
  request-context signal, not proof the client received anything.
- Handlers must use `http.NewResponseController(w)` for flush, hijack, deadlines
  and full duplex. `Unwrap()` forwards controller support; flush and hijack are
  intercepted to observe their effects. Unsupported operations return
  `http.ErrNotSupported`. Legacy assertions to `http.Flusher`, `http.Pusher`,
  `http.CloseNotifier` or `io.ReaderFrom` are outside this example's boundary;
  adapt such handlers before wrapping them. Ordinary `io.Copy` still uses Write.
  Never unwrap and write directly, which bypasses status tracking.
- Hijack is forwarded when supported. The event describes only the HTTP handler
  boundary: hijacked connection lifetime, raw handshake/status and WebSocket
  messages are unobserved. No 200 is inferred for hijack; only statuses observed
  before hijack survive. `Observation.Hijacked` is true and
  `Observation.ResponseCompleted` is false. A 101 also does not establish
  response completion or success. Supply a separate protocol adapter to measure
  the upgraded connection.
- Completion here means local handler/body production, not socket drain, client
  receipt, edge delivery, or broker acknowledgement. HTTP/2 and reverse-proxy
  delivery are not separately certified by these fixtures. Do not write after
  handler return or wrap a concurrently running timeout handler inside this
  middleware. For `http.TimeoutHandler`, place logging **inside** its handler so
  completion observes the inner work and its cancellation; use an ingress or
  dedicated adapter for the outer timeout response. A handler that calls
  `runtime.Goexit`, process termination, OOM or machine loss cannot be guaranteed
  to produce a truthful completion event.

`Measure(event, observation)` and `SLOFailure(event, observation)` receive local
boundary facts separately from the log schema. `ResponseCompleted` is false for
interruptions and hijack; `HandlerReturned` is not queue completion. This lets
user criteria avoid treating a sent 2xx with an interrupted body as a success.

## Capture and redaction

Header allowlists are empty by default. Configure `HTTP.RequestHeaders` and
`HTTP.ResponseHeaders` with approved names only. Names become lowercase, repeated
values remain arrays. Credential headers are excluded even if allowlisted.
Response headers reflect the application header map at final commit, excluding
later unsent edits; automatic transport headers/trailers are not reconstructed.

`HTTP.Metadata` may return only `route`, `params` and `query`. Empty params/query
maps are omitted. For a bounded incoming URL, `QueryValues(r.URL.Query(), "tag")`
selects only explicitly approved query keys and preserves repeated values.
Never approve credentials, OAuth code/state, or arbitrary payloads. `QueryValues`
redacts explicitly selected OAuth `code`/`state`; ordinary business/error `code`
and queue `state` fields retain their meaning. Do not call `r.URL.Query()` on an
unbounded arbitrary string; an HTTP server/ingress must bound request-line size.
The default top-level path is `EscapedPath()` without query or fragment. Supply
`HTTP.Path` to replace secret-bearing segments with an approved template, or
return empty to omit the path. A projection panic omits the path and increments
the logging failure counter.

Bodies are disabled by default, with a `body_capture: "disabled"` marker.
`HTTP.RequestBody` and `HTTP.ResponseBody` opt in independently; each returns an
approved projection and a capture boolean. The demo deliberately opts in only to
an `/orders` response ID. An enabled callback returning false means skipped or
unknown, so body and marker are absent. The middleware never consumes/clones a
request body or buffers response bytes: observe data the application already
parsed, using application/ingress input limits. Callbacks must skip files,
streaming and unsupported content types; flushed/hijacked responses are skipped
automatically. Do not stash raw bodies elsewhere in the business event.

Redaction applies recursively across errors, business fields and projections.
Credential names are matched case-insensitively after removing separators.
`AdditionalRedactions` adds app-specific names without replacing defaults. Email,
phone and MSISDN remain visible unless explicitly added. Repeated sensitive
values keep array shape, with `[REDACTED]` elements. Standalone URL values lose
userinfo, query and fragment. Bounded strings containing JSON objects/arrays are
parsed, sanitized and serialized back into strings to preserve their field type; malformed or excessive structured
strings are `[OMITTED]`, never forwarded unchecked.

Key matching cannot find arbitrary secrets in prose, embedded URLs, encoded
strings or path segments. Use controlled projections and an idempotent
`ScrubText` policy for all other approved free text, including native error
messages/stacks. No claim is made that a redaction marker proves complete secret
removal. Do not encode secrets in field names. This example does not scan SQL,
files or arbitrary binary payloads.

The defaults are 8,192 UTF-8 JSON bytes per projected body and 32,768 per complete
event (newline excluded), configurable with `BodyBytes`/`EventBytes`. Strings,
arrays and objects are shortened as values before serialization; JSON remains
valid. Shortened bodies get `body_capture: "truncated"` and retained redaction
markers. The full-event limit wins: previews shrink first, optional context is
removed next, and core ID/flow/status/timing/error and native job context are
preserved. Core error message/name/code may be shortened; if the minimal safe
event cannot fit, it is dropped and `Failures()` increments. No raw fallback is
emitted. Install receiver limits above this configured event size.

Traversal also caps depth (16), total nodes (4,096), members/items per container
(128), keys (256 bytes) and strings (65,536 bytes; structured strings 8,192).
Unsupported values/binary buffers become `[OMITTED]`; deep/cyclic values are
bounded without invoking arbitrary `MarshalJSON`/`String` methods. Oversized
optional maps keep a bounded subset, not a stable complete inventory. Custom
error methods and callbacks remain application code: they must finish promptly,
be concurrency safe and not panic. Panics are isolated and counted during
completion, without printing their possibly sensitive values.

## Sampling, measurements and worker adapters

Nil `Sampling.Rate` means 100%; set a pointer to `0.0` for 0% ordinary retention.
No slow threshold or SLO target is activated by default. The demo's create-order
criterion is an explicit example, not a library default.

At completion the logger sanitizes, classifies, invokes `Measure` for every
observation **before sampling**, evaluates `ShouldSample`, bounds the selected
event, and calls the one serialized sink. Measurement/SLO callbacks receive the
sanitized bounded-traversal snapshot before byte-budget pruning (integers are
`int64` or `uint64`). Callbacks must not mutate or retain this snapshot. Normal
successes are `info`, configured slow completed successes at **or above** the
threshold are `warn`, and errors/HTTP >=400 are `error` with priority. Confirmed
recovery is retained without raising severity or changing SLO classification.

`ShouldSample` retains recorded errors, HTTP >=400, warnings, user
`SLOFailure`/`Retain` matches, and confirmed retry recovery. Predicate failures
retain diagnostics and increment `Failures()`. Sink errors/panics are counted and
never change the application result. Measurement callback failures are counted;
serialization/sanitization failures may leave observations unclassified. Monitor
that health/coverage independently. Sinks are synchronous: use a bounded
application exporter if you need nonblocking delivery, and measure its losses.
There is no retry of a failed sink, so a partial sink write can still be lost.

Use `Measure` to update unsampled counters/histograms with bounded labels and
user-defined eligibility/good criteria. Never compute SLA/SLO ratios from sampled
JSON. Request IDs and arbitrary paths are not metric labels. Ingress failures
that never reach this handler need separate boundary coverage. No receiver,
persistence or quiet UI integration was tested by this producer example.

`RunJob(ctx, event, handler, confirmedRecovery)` accepts a mutable map and preserves
returned errors and re-panics after one completion attempt, leaving retry/ack
behavior to the native queue. Supply actual metadata directly:

```go
event := logging.Event{
    "job": logging.Event{"id": nativeJobID, "attempt": nativeAttempt},
    "flow": "send_receipt",
}
// Include request_id only if a real parent propagated it; independent jobs omit it.
err := logger.RunJob(ctx, event, func(ctx context.Context, event logging.Event) error {
    event["recipient"] = logging.Event{"email": approvedAddress}
    return sendReceipt(ctx)
}, func() bool {
    return brokerConfirmedFinalSuccess && nativeHistoryShowsRetry
})
```

The queue adapter supplies exact attempt numbering/history; this wrapper never
computes retry recovery from attempt >1, fabricates states or parent links, or
adds HTTP fields. A requested cancellation with a nil handler result is not
promoted to confirmed cancellation. Supply confirmed timeout/cancellation/error
facts from your queue. Pre-execution cancellation belongs to a separate native
lifecycle signal, without an invented execution attempt or duration. Worker loss
cannot produce a fabricated finalization.

`HandlerReturned` is just the local attempt boundary. `duration_ms` covers local
execution through handler return, excluding the post-handler recovery check and queue wait; put native queue
wait/total timing in job metadata only when actually available. The optional
recovery callback is evaluated after a successful handler and must observe
confirmed final queue success **and** retry history. It must not assume handler
return is a broker ack. If ack/final completion occurs after this wrapper returns,
pass nil/false here and move this wrapper to the queue's real terminal hook, or
emit a separately identified native lifecycle record excluded from attempt
counts. Do not retroactively emit a second canonical attempt event.

At rate zero: first success is sampled out; failed attempt is retained `error`;
confirmed success after retry is retained `info` (or `warn` if explicitly slow);
handler success with unconfirmed broker completion is sampled normally. User
SLOs choose per-attempt or logical-job population and execution/wait/total
measurement explicitly; recovery retention does not make the failed attempt good.
