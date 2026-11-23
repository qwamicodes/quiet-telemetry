# Wide-event middleware examples

Runnable references for quiet's [agreed logging guide](../../docs/logging-guide.md), based on Boris Tane's [`wideEventMiddleware` and `shouldSample` examples](https://loggingsucks.com/) and the [logging-best-practices skill](https://github.com/boristane/agent-skills/tree/main/skills/logging-best-practices). These are language adaptations of that pattern, not an author-published multi-language SDK.

| Language | HTTP integration | Start here |
| --- | --- | --- |
| TypeScript | Elysia plugin plus Fetch response-body wrapper | [Instructions](typescript/README.md) · [Middleware](typescript/elysia.ts) · [Sampling and worker](typescript/logging.ts) |
| Python | ASGI send/receive lifecycle | [Instructions](python/README.md) · [Middleware and worker](python/wide_events.py) |
| Go | `net/http` handler and response writer | [Instructions](go/README.md) · [Middleware](go/http.go) · [Worker](go/worker.go) |
| Rust | Axum middleware and response-body wrapper | [Instructions](rust/README.md) · [Middleware](rust/src/http.rs) · [Worker](rust/src/worker.rs) |

Each example has an isolated package, demo and behavior tests. Follow its README for exact toolchain requirements and commands. They do not install instrumentation into quiet or update its app guide or Paper design.

Verified on 17 November 2026:

| Package | Verification |
| --- | --- |
| TypeScript | TypeScript check; 18 Bun tests; worker demo |
| Python | 25 unittest tests, including 2 Starlette integration tests; dependency check; demo |
| Go | 20 top-level tests plus subcases under the race detector; vet; formatting; HTTP and worker demos |
| Rust | 18 integration tests; format check; Clippy with warnings denied; HTTP and worker demos |

Documentation checks also validate all 26 JSON examples and the relative file links in these READMEs and the three guide documents. These checks cover the reference packages; app ingestion, persistence and real queue integration are outside this pass.

## The shared behavior

1. Create one mutable event per request or attempted job execution. Handlers assign business fields directly, including `flow`, `user` and `order`.
2. Finish at the adapter's documented completion boundary. Use actual HTTP status, UTC completion time and monotonic elapsed time. Keep request/job identity separate from business facts.
3. Measure every eligible completion before diagnostic sampling. Your code supplies the SLO scope, population, success criteria and thresholds. The measurement callback must update your existing metrics system; these examples do not provide durable SLO aggregation.
4. Retain recorded errors, HTTP statuses >=400, configured slow operations, SLO failures, extra business retention conditions and confirmed successful retry recovery. Sample other successes at the configured rate, defaulting to 100%. Recovery evidence comes from the queue integration, not an assumed attempt number.
5. Assign `error` before `warn` before `info`. A slow success is `warn`; ordinary success is `info`. There is no separate success level.
6. Project approved headers and optional bodies, redact credential keys recursively, then write bounded JSON through one configured sink. Email, phone and MSISDN remain visible by default. Bodies are off by default; body/event limits default to 8,192/32,768 UTF-8 bytes.

No calls array, recorder class or manual emission method is required in handlers. The middleware owns emission. Redaction, capture limits, SLO callbacks and worker recovery are quiet's agreed additions to the author's teaching pattern.

## Configure before using

- Set service/environment and connect the existing structured logger to the sink. Avoid wrapping already serialized JSON inside another logger message field.
- Supply your SLO criteria and independent sample rate. Demo thresholds are examples, not recommended targets or automatic defaults. Use the guide's [editable templates](../../docs/logging-guide.md#10-copyable-implementation-prompt).
- Select trusted request-ID sources, safe path representation, approved headers/body fields and any custom sensitive keys or free-text scrubber. Structural key redaction cannot find arbitrary secrets embedded in prose or URLs.
- Bind each worker wrapper to the queue library detected in your application. Supply native job identity, retry history, parent links and completion evidence. The demos do not implement queue scheduling, retries, broker acknowledgements or cancellation state machines.

API spelling follows each language and framework; the event contract and retention rules remain the same. Start with one package rather than copying all four into a service.

## What completion means

HTTP adapters observe a local framework/body boundary, not proof that a client received or consumed the response. Read each adapter's streaming, disconnect, panic/error and upgrade limitations. A process crash can prevent emission; an unsent record is not evidence that work succeeded or failed.

Worker wrappers observe attempted execution. A handler returning may precede the broker acknowledging completion. Queue adapters must establish the evidence needed for recovery retention and logical-job SLOs. An attempt counter alone cannot establish either.

The sinks receive sanitized diagnostic output. Measurement callbacks are trusted application code and receive the event to classify it: export bounded metric labels, not raw user data. Delivery monitoring, exporter flushing and durable measurement remain responsibilities of the application's existing telemetry setup.

See the [use-case walkthrough](../../docs/logging-use-cases.md) for the same request, error, retry and child-job scenarios expressed as JSON and the [proposal](../../docs/logging-proposal.md) for the app/UI work that follows.
