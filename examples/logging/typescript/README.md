# TypeScript / Elysia reference

Adaptation of Boris Tane's [wideEventMiddleware and shouldSample examples](https://loggingsucks.com/) and his MIT-declared [logging-best-practices skill](https://github.com/boristane/agent-skills/tree/main/skills/logging-best-practices). Direct enrichment is preserved. Redaction, body projections, SLO callbacks, framework lifecycle handling and job-recovery retention are the agreed quiet adaptations, not an SDK published by the author.

Tested with Bun 1.4.2, Elysia 1.4.32 and TypeScript 7.0.2. Dependencies are locked independently from quiet's app.

```sh
cd examples/logging/typescript
bun install --frozen-lockfile
bun run check
bun test
bun run demo
```

The demo listens on port 3100. Send `POST /orders`, `GET /handled`, or `GET /throws`. Demo SLO/sample settings are illustrations, never auto-selected for another service. A normal success may not appear at the example 10% sample rate; set it to 1 while inspecting. Run the queue-neutral recovery fixture without a server:

```sh
bun -e 'import { workerDemo } from "./demo"; await workerDemo()'
```

## Use

`wideEventMiddleware(options)` returns an Elysia `plugin` and an outer `fetch` wrapper. Install both, before registering routes:

```typescript
const logging = wideEventMiddleware(options);
const app = new Elysia().use(logging.plugin)
  .post('/orders', ({ wideEvent, status }) => {
    wideEvent.flow = 'create_order';
    wideEvent.order = { id: 'ord_example' };
    return status(201, { order_id: 'ord_example' });
  });
Bun.serve({ fetch: logging.fetch(request => app.handle(request)) });
```

The plugin supplies `wideEvent` and captures framework errors and optional parsed-body projections. The wrapper sees the actual mapped Response, sets the request ID header, and emits at local body EOF, error or cancellation. It preserves the author’s one-event lifecycle without relying on Elysia's private `.wrap` API. `finish` in logging.ts is middleware infrastructure, not a handler API. The generic Fetch wrapper can also surround other compatible handlers, which would supply their own direct event-enrichment binding.

`Options` configures the existing JSON sink once. `observe(event, completion)` runs for every completion before sampling; implement bounded-label SLI counters there. `sloFailed` and `retain` are application predicates over the completed event, not emitted schema fields. Supply scopes and exact thresholds from the user's objectives. Exceptions in telemetry callbacks are isolated and reported via `onDrop`; sampling predicate failures conservatively retain the event. A failing measurement callback means incomplete metric coverage, not a successful SLO update.

Request IDs are generated unless `trustRequestId(request)` explicitly allows the incoming validated ID. Forward that ID only through the application's trusted outgoing clients/queue adapters. This example does not intercept global fetch or assume a queue library. Raw query and route params are not collected automatically; add only approved fields through application-specific projections. Use `path(url)` when URL segments can contain secrets.

`write` may return a promise; rejection is reported through `onDrop`. Completion does not await network export. Use the existing sink's flush/shutdown mechanism before process exit; this example provides no durable delivery queue.

## Capture and redaction

Bodies are disabled by default. `requestBody(path, parsedBody)` and `responseBody(path, returnedValue)` project approved JSON values for opted-in routes; return undefined to skip. The Elysia custom status result is unwrapped for response projection. Response objects, files and generator/stream content are not read for body capture. Header allowlists are explicit. Fetch combines most duplicate header values; `set-cookie` is preserved as an array, and the example cannot reconstruct duplicates that Fetch already combined.

Credential keys are matched case-insensitively after removing separators. Additional `redactKeys` apply recursively, including arrays and errors. Email/phone are visible by default. Strings inside error messages or other free text may contain secrets that key matching cannot recognize: use controlled error summaries and `scrubText` for the application's formats. The example does not claim universal secret detection.

The serializer copies values without invoking object getters or `toJSON`, handles cycles and unsupported values, and enforces UTF-8 limits (8,192 body / 32,768 event bytes by default). Safe previews are shortened as valid JSON; oversized bodies get `body_capture: truncated`. Optional fields may be omitted to fit a full event. If core fields still do not fit, `onDrop('event_too_large')` is called and the event is omitted. Independent recursion/collection/string bounds prevent runaway traversal; very large or unsupported values are represented by markers, so projections should stay small. The emitted output never falls back to the raw original on failure. These bounds are implementation safeguards, not required event metadata.

## Jobs and lifecycle limits

`wideEventWorker(metadata, process, options, confirmedRecovery)` demonstrates the same pattern for a single attempted execution. It passes a fresh event directly to the processor, preserves native job fields, omits HTTP fields, and retains failures and confirmed retry recovery at a 0% rate. `confirmedRecovery` is evaluated after the processor completes; a real queue adapter must supply native retry/completion evidence. A processor returning is not necessarily the broker acknowledging completion—place the wrapper at the boundary your queue actually exposes. Do not infer recovery from `attempt > 1`, as numbering and semantics differ.

Queued/running/cancelled-before-start and parent/child links require the queue's own lifecycle integration. No job duration is invented when execution never began. The worker fixture does not implement a queue, retries, cancellation, broker acknowledgements, scheduled runs, or durable SLO storage.

The HTTP boundary is **local response-body completion**, not proof of network delivery or client consumption. Tests must drain or cancel the body. An unconsumed body stays incomplete. WebSocket upgrades and opaque responses are unsupported; use a protocol-specific adapter rather than installing this example over upgrades. Process kill/crash can prevent completion entirely. The wrapper forwards body data without buffering it for logging; actual socket disconnect behavior still depends on the hosting server forwarding cancellation. Supplying body projections cannot turn an unsupported stream into a captured body.

Sources: [Elysia lifecycle](https://elysiajs.com/essential/life-cycle), [Streams read semantics](https://streams.spec.whatwg.org/#default-reader-read).
