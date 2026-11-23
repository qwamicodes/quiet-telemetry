# Proposal: complete, safe canonical logging

18 November 2026 · logging contract, guide, producer references and Paper design pass complete; app implementation pending

## Recommendation

Keep quiet's visual identity and existing Stream → Flow → Field card workflow. Make the canonical completion event the common contract, give request and response context equal treatment, and make capture/redaction state explicit. Remove the calls array and call-recording helpers from the proposed contract. Build SLO measurement on a defined, unsampled population with coverage evidence, not the visible log rows.

The [guide manuscript](logging-guide.md) contains the schema, capture policy, language adaptation notes, examples, SLO/SLA guidance, verification checklist and implementation prompt. The [approved end-to-end walkthrough](logging-use-cases.md#17-approved-request--job--retry--child-job-walkthrough) ties the request, failed attempt, successful retry and child jobs to the activity-list design. The [runnable producer references](../examples/logging/README.md) add TypeScript/Elysia, Python/ASGI, Go/net/http and Rust/Axum middleware, worker wrappers, demos and tests. They demonstrate producer redaction and sampling, with callbacks for user-defined SLO measurement. The Paper design pass is complete; see [the current screen review](logging-paper-review.md). The manuscript is not yet published into the app, and quiet instrumentation, pre-storage redaction and durable SLO aggregation remain implementation work. Native queue adapters remain specific to each user's codebase.

The user-supplied [Logging Sucks](https://loggingsucks.com/) article is the primary middleware teaching reference. Guide section 5 now explicitly maps its pattern to quiet's response lifecycle, redaction and measurement requirements. Keep the implementation centered on one enriched request event; handlers add business context without maintaining call lists.

The copyable prompt is the primary guide deliverable: select a language/framework, provide logging settings and SLOs (with editable templates), then copy the tailored instructions. Base generated middleware on Boris Tane's `wideEventMiddleware()` and `shouldSample(event)` examples and the `logging-best-practices` skill. Translate their behavior idiomatically; preserve direct event enrichment and explicitly document remaining agreed schema/policy differences. Do not introduce a separate logging architecture or present reference snippets as a ready-made multi-language SDK. Guide section 10 contains the prompt draft for review.

## What the review found

| Area | Evidence in this repository | Implication |
| --- | --- | --- |
| Ingestion stores the received values | `server/src/pipeline.rs:123–165` normalizes, stores and broadcasts; `server/src/normalize.rs:167–191,312–324` retains fields and raw; `server/src/store/sqlite.rs:589–616` writes raw/index data. | Export masking does not protect stored or live records. Add sanitization before raw retention, normalization-derived indexes and broadcasts. |
| Export masking is a separate feature | `server/src/export.rs:123–141,260–354`; `server/src/search_api.rs:184–205,252–280`. | Current optional/role-based masking and its limited patterns are not a general secrets policy. Never call existing logs safe simply because an export is masked. |
| Calls are a quiet presentation feature | `server/src/flow.rs:445–494` reads calls and makes child nodes; the guide prescribes `wideEvents.calls`. | Remove call arrays and helpers from the new contract. Existing app behavior is unchanged in this documentation pass. |
| The guide contradicts its own unit boundary | `docs/agent-logging-prompt.md` promises one event per attempt, then requires picked-up/failure/completed lifecycle lines. | Label optional operational events separately; one canonical summary per attempt remains the invariant. |
| Canonical lint is a heuristic | `server/src/lint.rs:323–357` counts status/duration lines by request ID in a recent sample. PII checks at `145–191` are limited. | Label inference and sample limits without requiring extra event identifiers. A green check cannot certify delivery or privacy. |
| Request fields lack dedicated grouping | `web/src/components/field-card.tsx:55–83` recognizes top-level request fields; nested request/response fields fall into other groups. | Add semantic sections to the existing field card. Keep generic JSON and Diagram inspection. |
| Guide content has multiple maintained surfaces | `docs/agent-logging-prompt.md`, `web/src/guide/agent-logging-prompt.md`, `web/src/lib/guide.ts`, `web/src/routes/guide.tsx`. | Synchronize copyable prompt, stack notes, explanatory fields and checklist together when implementing. The existing test checks the two prompt files match. |
| SLO infrastructure is not present | `server/src/store/mod.rs:9` describes rollups as future work. Existing search/lint cannot calculate a trustworthy SLO. | Add durable aggregates and coverage accounting before promising SLO/SLA reports. |

These are static code findings, not a claim about the contents or configuration of a deployed instance. Line references describe the reviewed checkout.

## Design review

Reviewed the supplied [Stream design](https://app.paper.design/file/01M5FGX308Z91AH0ASQT1KSH48/p-2-0/14XE-0), the existing Flow/Guide pages, the [Minimal additions revision](https://app.paper.design/file/01M5FGX308Z91AH0ASQT1KSH48/p-17-0), the earlier log-context review, and the [SLO detail](https://app.paper.design/file/01M5FGX308Z91AH0ASQT1KSH48/p-O-0/2FF8-0).

The minimal revision remains the starting point for the shell, table columns, typography and field-card tabs. The Flow detail view now follows the agreed activity-list direction below, replacing the graph as its default presentation. The reviewed request-context view separates an OAuth application failure from an HTTP redirect and explains missing bodies, but still needs equivalent response treatment. The earlier review contains useful delivery and OTLP requirements; retain those as requirements, not claims about today's product.

### Stream and flow

- Keep the existing table and density. Add a compact “context available” or redaction indicator only where useful; do not fill rows with header/body previews.
- Show a recorded error alongside HTTP status. A failed sign-in with HTTP 302 must retain its error indicator rather than appearing successful solely because it redirected.
- In the existing Flow column, show top-level `flow` assigned directly to the event. In Summary, show method, path and response status, such as `POST /orders → 201`, with an error indicator when an error is recorded. Keep the existing timestamp, level, request ID and duration. A row reads `info · create_order · POST /orders → 201 · 142 ms`. If `flow` is absent, fall back to method plus route (sanitized path if no route template), then the existing legacy label. The operation name is not a correlation ID.
- Explain the existing STEPS count using actual records and spans. Do not add synthetic steps from a calls array to the proposed workflow.
- In a flow, identify “Request summary,” “Job attempt,” “Application log,” and “Span.” Preserve each signal and its provenance; correlation does not imply duplicate data or causal order.
- Keep IDs at top level for stitching. A shared request ID is correlation, not proof of a parent-child relationship; use span parents or explicit enqueue links where available.

### Flow detail — agreed activity list

Preserve the visual identity and compact rows. Open Flow into one activity list with the existing field card for selection details.

- Show one row per request or logical job, with its name, service, observed state and duration. For jobs, explicitly label the row timing as execution time; put queue wait and total elapsed time in expanded details when available. Service/worker identity is supporting row information rather than a separate graph lane.
- Group attempts inside their job row. Show an attempt count and expand to inspect individual timings and errors. A verified later success can read “Completed after retry”; retain the earlier failures. This is a job-state label, not a new log level. UI grouping does not change the one-summary-per-attempt logging rule.
- Show child jobs beneath their parent only when an existing queue relationship or tracing evidence establishes that relationship. Shared request IDs alone produce related work, not invented parentage or execution order. Parallel siblings must not look like a sequential chain.
- Selecting a request or attempt opens its actual event in the existing field card. Keep Fields / JSON / Raw / Diagram; the field card's JSON diagram is separate from the Flow graph.
- Remove the graph, service lanes, minimap and zoom controls from the default Flow screen. Put detailed timing behind an explicit action. Avoid showing the same activity as both a timeline and graph by default.
- Show Queued or Running only with queue lifecycle evidence. For known work with no observed completion, use “Completion not observed,” not an inferred state. A failed attempt alone does not prove the job exhausted its retries.

Use existing queue identities, including their service/queue scope, to group attempts; never group jobs by operation name alone. If attempts or completions may be missing because of sampling or retention, expose that limitation. Keep HTTP acceptance separate from background completion, and label execution duration separately from queue wait or end-to-end time when available. The prompt detects each user's queue systems and versions from the codebase, then explains their native field/hook mappings before implementation. Support multiple systems or none; ask only when code inspection cannot resolve a choice. Quiet does not prescribe a queue library.

### Field card and request context

Agreed interruption behavior: Cancelled requires confirmed queue cancellation, not just a request to stop. A timed-out attempt retains its error and uses Retry scheduled or Failed according to confirmed queue state. Worker disappearance alone means Completion not observed; never manufacture completion records. Cancellation before execution uses lifecycle evidence without an invented attempt or execution duration. The user’s SLO determines cancellation eligibility and failure/exclusion treatment.

Agreed child-job behavior: each child keeps its own attempts, completion records and SLO treatment. Use native queue relationships to nest children, and preserve the originating request ID when available. A collapsed parent can show its known child count; incomplete observed counts must not imply all children were discovered. Do not imply sequential execution between siblings or treat parent completion as child completion. Respect queues that explicitly wait for child dependencies. Without relationship evidence, show related work instead of nesting.

Agreed job states are Queued, Running, Retry scheduled, Completed, Completed after retry, Failed, Cancelled, and Completion not observed. Map native queue evidence to these UI labels. Retry scheduled means another attempt is confirmed as planned; Failed means the queue confirms terminal failure. A failed attempt retains its error severity after eventual success. Missing completion records cannot establish a current queue state or terminal outcome; show Completion not observed when neither is evidenced. These labels do not change the four log-level filters or require a new emitted state field.

Agreed retry retention: failed job attempts and confirmed successful completion after a retry always bypass normal sampling. Successful first attempts use the normal sampling policy unless another retention rule applies. Implement this condition in `shouldSample(event)` using the detected queue's actual retry history and completion evidence, accounting for its attempt numbering. Keep the recovery's info/warn level and the user's SLO classification unchanged. Verify both failure and recovery are selected with normal sampling set to 0%; transport loss and expiry remain separate reasons for incomplete history.

Job timing follows the user's SLO: a queue-wait or total-elapsed breach must force retention even when execution is fast. Reuse the detected queue's actual timing fields, document their boundaries and keep missing measurements unknown. Do not substitute execution time for missing total time or sum observed attempts into an assumed complete job duration. When attempts are grouped, identify which attempt a displayed execution time describes.

Agreed: keep the existing field card and Fields / JSON / Raw / Diagram tabs. Within Fields, show Request, Response, Context and Error groups. Context groups top-level `flow` and business fields for display only; it does not imply a JSON wrapper. Omit the Error group when no error exists; make its extra details expandable. Keep timestamp, service, environment, request ID and duration in a compact summary. Bodies expand on demand, with Disabled or Truncated labels from `body_capture`. Preserve the existing visual style and resizable card.

Request contains headers, route parameters, query and body preview. Response contains actual status, headers and body preview. The top summary and Response may display the same stored status; the payload has one authoritative field. Use strings for single header/query values and arrays for repeated values, omit empty params/query objects, wrap long safe values and expose copy on a deliberate button. Keep field names and actions aligned in fixed-width lanes. Large values expand within the card; do not grow every stream row.

Show the agreed Disabled and Truncated body markers plus redacted values. Partial redaction and truncation can coexist. Missing metadata means unknown; do not require new capture envelopes or infer a removal reason.

Use one redacted-value component across Fields, JSON, Diagram, previews and export descriptions. Show a lock plus “Redacted,” with a textual accessible label. Never include hidden originals in DOM attributes, tooltips or clipboard data. A redacted value can support “Find records with redactions”; “Filter by this secret” is unavailable.

Relabel Raw's explanation to “Sanitized received record.” The original wire bytes are not retained under the proposed policy. Do not infer why unsupported or absent content is missing. Do not present a secret reveal control.

### Sources and settings

Make three concepts distinct in copy: producer capture (what the app emits), ingestion redaction (what quiet may retain), and export formatting/masking (what a file includes). Body capture must be configured where the producer can observe it; a quiet toggle cannot recover a body that was never sent.

Show policy version, safe rules and last effective update. Use a synthetic test event to preview removal by field path. Mandatory credential rules cannot be disabled as an export preference. Source-specific rules may add restrictions; authorize exceptional changes deliberately. Report policy failures without retaining rejected secret-bearing payloads.

### Guide and Check my logs

Keep the five current guide tabs and their navigation. Put the manuscript's quick start in Overview; the common brief plus language recipes in Instrument with an agent; the schema and Request/Response/Redaction sections in The canonical line; work identity and correlation in Ids & flows; and the behavioral verification list in Check my logs. Add a clearly marked reliability section explaining what is available now versus proposed SLO support.

Teach the author’s direct event enrichment, `wideEventMiddleware()` and `shouldSample(event)` conventions. Remove call-recording helpers from the guide. The stack picker changes adapters, not the data contract. Include Rust as a first-class recipe because quiet's backend uses it. Do not add a custom recorder class or helper API. Framework translations must preserve the author’s lifecycle and event enrichment behavior.

Add “Your SLOs and emission rules” to Instrument with an agent. Let users enter their own objectives or choose and edit a guide template before copying. Include those values with the selected language notes in both Copy prompt and Download. Templates are examples, never silently applied defaults. Support “not configured” for SLOs. Derive slow/failure retention conditions in `shouldSample(event)` from the same scope, success criteria and latency boundaries as the user’s SLOs. Keep any eligible event failing an applicable objective’s per-request criteria, plus recorded errors, HTTP >=400 and explicit additional business retention conditions. Do not introduce a manual retention API. Sampling percentage remains a separate user setting; it is not inferred from the SLO target. Keep SLI measurements unsampled. The guide manuscript includes a general API example and a keep-everything setup example.

Check my logs should show separate categories: format, canonical lifecycle, capture policy, correlation and delivery evidence. Show sample size/window and “Not applicable” for ordinary logs. Privacy scanning is heuristic; delivery needs independent expected counts. Do not collapse these into a reassuring global quality score.

### SLO/SLA components

Use the existing SLO designs after defining measurements. Add objective scope and policy version, eligible/good/bad/excluded counts, measurement source, coverage, freshness and objective window. Every budget link should open the matching eligible failures, with context explaining records that have expired.

The reviewed SLO board uses a 7-day objective but 14.4×/6× burn presets commonly illustrated for a 30-day budget. Recompute from the desired budget fraction and window, or state the intended policy explicitly. Rounded percentage displays must not drive counts or budget arithmetic.

Zero traffic is “No data.” Known delivery gaps are “Insufficient coverage,” not healthy green. A monthly SLA report needs a complete calendar period, timezone, versioned agreement definition and coverage statement. Newer deployments or shorter retained windows cannot imply a fully observed month.

## Contract decisions proposed for review

1. **Simple JSON shape — agreed:** keep IDs, service and duration at top level. Use top-level `method`, `path` and `status_code`, matching the author. Group request/response headers and optional bodies under `request` and `response`, with request parameters/query there too. Put business fields directly on the event without a wrapper. Omit empty params/query objects and use strings for single header values. No extra schema-version, event-kind, work-ID or capture-provenance fields are required. Update readers for nested fields with legacy fallback; do not duplicate fields in emitted events.
2. **Calls removed — agreed:** no `wideEvents.calls`, call-recording helper or dependency-list requirement in the proposed contract. Keep business context on the completion event. Removal of existing app rendering/lint support is a later implementation edit; do not delete historical records.
3. **Body capture — agreed:** request/response metadata on; body capture off by default, enabled independently per route and direction. Redact and size-limit captured bodies; skip files and streams. Use `request.body_capture` or `response.body_capture` with `disabled` or `truncated` to explain omitted/shortened capture. Keep the markers simple; agreed byte limits are listed below. Use safe route templates for metrics; never raw paths/query values.
4. **Privacy boundary:** producer sanitization plus quiet pre-storage enforcement; safe stored data shared across every read/export surface. No raw-secret archive or reveal feature.
5. **One summary:** one terminal event per service execution or job attempt. Ordinary logs and spans remain distinct and inspectable.
6. **Reliable metrics:** unsampled metrics at the defined boundary are the preferred denominator; logs explain failures. Log-derived SLOs require durable dedupe, aggregation and coverage checks.
7. **User-supplied objectives — agreed:** the prompt accepts the user's SLOs and emission rules, with editable examples in Guide. Retention and SLI measurement share the user’s SLO scope, success criteria and latency boundaries. Events failing any applicable objective’s per-request criteria are retained, alongside recorded errors, HTTP >=400 and explicit additional business conditions. Extra retention does not alter SLO eligibility. Sampling percentage is independent of the SLO target; no invented targets, and unspecified sampling keeps all events.
8. **Business summary — agreed:** assign `flow` and other business fields directly to the event, following the author’s convention. No `context` or `wideEvents` wrapper and no custom enrichment helper. Remove the outcome field. Show the operation, HTTP status, duration and any recorded error in the stream.
9. **Redaction defaults — agreed:** use one shared configuration across request, response, business fields and errors. Redact credentials, authorization headers and cookies by default. Leave email addresses and MSISDN/phone values visible when captured, unless the user adds them to custom redaction rules. Allow additional app-specific sensitive fields. Replace removed values with `[REDACTED]` before logging.
10. **Flexible errors — agreed:** middleware captures unhandled errors; handlers assign handled-error details to `event.error`. Preserve standard/custom error fields, including `reason` and `details`, with their JSON types. Normalize a plain-string error to `{ message }`. Omit absent fields, support custom serializers, and apply redaction/size limits after serialization. Recorded errors bypass sampling and are included in the single completion event. Show available code/message first, with other fields expandable.
11. **Request IDs — agreed:** middleware reuses a valid ID from a trusted upstream or generates one, records it as `request_id`, and returns `x-request-id` in the response. Configured client/queue adapters propagate it to the application's own services and request-started jobs. Keep handler code free of manual ID plumbing, preserve isolation between requests, and do not forward IDs to arbitrary external destinations.
12. **Automatic metadata — agreed:** use top-level `timestamp`, `service`, `env`, `request_id` and `duration_ms`. Set `timestamp` at completion in ISO 8601 UTC, configure service/environment once, and measure elapsed duration with a monotonic clock. Do not also emit `time`. Preserve useful deployment metadata already supplied by the existing logger without adding mandatory fields.
13. **Four log-level filters — agreed:** keep Debug, Info, Warn and Error; no new Success level. Middleware assigns `error` for recorded errors or HTTP >=400, otherwise `warn` for completed successful requests at/above the configured slow threshold, otherwise `info` for successful completion. Preserve existing diagnostic/library levels, including Trace grouped under Debug and Fatal under Error. Warn/error events bypass normal canonical sampling. Verify matching normalization, badges, counts, histograms, stream and search filters during implementation; preserve existing stored level mappings.
14. **Size limits — agreed:** configurable defaults of 8 KB per captured body and 32 KB per event (8,192/32,768 serialized UTF-8 bytes). Shorten body previews first, mark `body_capture: truncated`, preserve IDs/flow/status/timing/core error information, and keep valid JSON. Include both editable limits in the setup prompt.
15. **Stream row — agreed:** preserve the existing design and columns. Flow displays `flow`; Summary displays method, path and response status. Keep timestamp, level, request ID and duration. For records without `flow`, use method plus route/path and existing legacy labels as fallback.
16. **Field card — agreed:** preserve Fields / JSON / Raw / Diagram. Within Fields, group Request, Response, Context and Error, omitting Error when absent. Keep automatic metadata in a compact summary. Expand bodies and additional error fields on demand; show Disabled/Truncated body labels. Retain the visual style and existing resizable card.
17. **Simpler Flow — agreed:** use one activity list, one row per request/job, expandable attempts and evidence-backed child relationships. Keep the existing field card. Move detailed timing behind an action and remove the graph/minimap/zoom from the default view. Queue states and terminal job results require observed evidence; retain unknown/incomplete states honestly.

The [use-case walkthrough](logging-use-cases.md) covers handler enrichment, resulting JSON, sampling reasons and SLO treatment using the settled fields. Use it with the [language-specific middleware references](../examples/logging/README.md) when reviewing an adaptation.

## Implementation order and acceptance gates

The Elysia/TypeScript, Python, Go and Rust producer references are available under examples/logging. They preserve direct enrichment and middleware-owned finalization with idiomatic syntax. The remaining implementation gates below concern integrating that behavior into quiet and each consuming codebase. The Paper pass is documented in [the current screen review](logging-paper-review.md).

### 1. Agree the contract and fixtures

Review the guide and proposal, settle capture policies, and detect the user's producer frameworks and job systems. Adapt hooks to the installed versions rather than selecting a queue library for quiet. Add relevant fixtures for success, failed redirect, recovered dependency, retry, abort and old untyped logs. Validate finite/nonnegative timings, status types, body markers and safe serializable values. Route-based body projections require an explicit service owner; the safe default needs no speculative body collection.

### 2. Enforce safety and preserve transport semantics

Adapt the author’s producer middleware and add pre-sink sanitization. On quiet, sanitize/reject unsafe input before retaining any raw representation, extracting IDs, indexing or broadcasting. Parse with resource bounds; if inspection cannot complete safely, emit a payload-free rejection diagnostic. Do not byte-cut unsanitized input and pass the remainder as plain text. A safe replacement envelope may be stored when documented, but must not count as a successful canonical event.

Verify OTLP preserves the complete safe event and does not reduce it to `msg`. Adapt span attributes using the installed OpenTelemetry convention; the proposed structured body projection is an application log field, not a claim that an OTel HTTP span body attribute accepts arbitrary JSON. Preserve event time versus observed time and distinguish logs from spans.

Choose one authoritative collection route per stream, preserve existing transport identifiers on delivery retries, and define retry/acknowledgment behavior against the actual storage backend. Do not promise disk durability in memory-store mode. Sanitize before indexing IDs; a credential misconfigured as a flow ID must not escape into an index.

Acceptance: synthetic secrets are absent from every sink; concurrency and lifecycle tests show one summary per unit; safe fields survive the real exporter; rejected/failed storage writes and overflow are visible. Define historical-data remediation separately before claiming old logs are protected.

### 3. Improve inspection and synchronize the guide

Implement the agreed Flow activity list, expandable job attempts, field groups, response context and body/redaction markers using the existing components. Make semantic UI changes in Paper using the existing tokens and components, then match the app. Handle old strings, `[masked]` and absent capture metadata without pretending they conform to the new contract.

Update both prompt copies, stack notes, guide field descriptions, done checklist and lint semantics together. Normalize `flow`, `method`, `path`, `request.route` and `status_code` for stream, flow, search, mute rules, lint and future SLI readers. Keep legacy aliases readable; new producers emit top-level business fields and method/path/status_code, with headers and optional bodies grouped under request/response. Canonical uniqueness should use service/execution identity, not assume a request ID is unique across every service hop. Old logs use explicitly labeled heuristics. Test copy/export/Raw paths alongside the visible field card.

Acceptance: no secret-bearing values in any UI/API copy path; request and response context have clear states; keyboard and narrow/resized layouts remain usable; guide examples and deployed behavior agree. Verify a single request, a job succeeding after retry, sibling jobs running in parallel, a child job, and missing completion evidence in the list. Same-named jobs and queue-local ID collisions must not merge; selecting an attempt opens its correct event. Existing prompt-parity and targeted Flow/guide/field-card checks pass.

### 4. Add objective storage and aggregates

Store versioned objectives independently from logs. For log-derived aggregates, dedupe by trusted producer scope plus event ID, atomically account for new events, and retain the dedupe ledger for the accepted replay horizon. Detect conflicting reuse of an event ID rather than silently overwriting counts. Reject or explicitly classify events outside that horizon; document corrections and late-arrival windows. Do not dedupe distinct requests by message, timestamp or request ID.

Retain eligible/good/bad/excluded counts, duration buckets and coverage markers beyond raw-log retention for the configured objective/report window. Pick the required aggregate retention from reporting needs rather than the current 24-hour log window. Neither mute rules, stream filters nor user-selected levels alter the SLI population. Never sum duplicate observations from edge, app and spans.

Acceptance: hand-calculated fixtures match aggregate results; replay/restart is idempotent; gaps and no-traffic periods are labeled; presets match window arithmetic; reports cannot claim an unobserved period meets an SLA. Enable customer-facing reports only after measurement has accumulated sufficient history.

## What becomes easier

An engineer can open one failed operation and see what was attempted, what was returned, which safe inputs matter, and exactly why some values are unavailable. The same completion boundary provides consistent records across languages. Handlers add business facts to that event without recording each internal call. Reliability measurements then use those agreed semantics with a trustworthy denominator, and link back to the events that explain budget consumption.
