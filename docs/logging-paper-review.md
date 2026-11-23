# Logging workflow — Paper review

18 November 2026 · agreed logging design pass complete · application implementation remains separate.

The designs remain in **portal v0.1.0**, using quiet’s existing shell, typography, tokens, controls and density. Review by the page and screen names below. The earlier “Logging · additional states” page was deleted and is no longer a review destination.

## Pages to review

| Paper page | Updated content |
| --- | --- |
| v0.1.0 · 03 · Stream | Logging rows, four levels, all Stream states and resizable columns. Look for v0.1.1 screens. |
| v0.1.0 · 04 · Flow & field card | Request/job activity list, attempts and related work; Fields, JSON, sanitized Raw and Diagram; headers, bodies, redaction and capture limits. |
| v0.1.0 · 05 · Search & export | Nine existing screens updated in place, now named v0.1.1-05.1 through 05.9. |
| v0.1.0 · 06 · Sources & per-source settings | List, overview, logging setup, redaction settings/preview and rejected-data states. |
| v0.1.0 · 11 · How to use | Prompt setup, generated prompt, 20 product templates, editable goals, language examples, event examples and verification. |
| v0.5.0 · 01 · SLOs & SLA | Six existing screens updated in place; eight compact drawer/report states below them, using the same styling. |

## Search and export

| Screen name | Behavior represented |
| --- | --- |
| v0.1.1-05.1 · Search · Results | Stored events grouped by correlated flow; request summaries and failed job attempts, consistent severity and matching counts. |
| v0.1.1-05.2 · Search · Time range | Existing picker, source retention and Africa/Accra timezone. |
| v0.1.1-05.3 · Search · No results | Broaden the time range or use observed flow values. |
| v0.1.1-05.4 · Export · Stream | Selected source, filters, time range, format and compression. |
| v0.1.1-05.5 · Export · Search columns | Export matching events; choose/reorder fields, including flow and status_code. Nested CSV values remain JSON and missing values remain empty. |
| v0.1.1-05.6 · Export · Flow | Updated activity-list background; two stored completion events, request and job, ordered by completion time. |
| v0.1.1-05.7 · Export · Preparing | Saved export snapshot, progress, cancellation and closing while the export continues. |
| v0.1.1-05.8 · Export · Ready | Download-ready toast over the updated Stream. |
| v0.1.1-05.9 · Search · Muted events | Explicitly include muted stored events. Muting does not change measurement eligibility. |

NDJSON, JSON, CSV and optional stored JSON all use sanitized stored data. Redaction is always applied, with no reveal/original-secret switch. Email and phone remain visible unless custom source rules hide them. Expired or sampled-out events cannot be recovered by export. The copied command uses a placeholder token, canonical field names and no optional masking parameter. These are design requirements, not claims about the existing export implementation.

## SLO and SLA journey

| Screen name | Behavior represented |
| --- | --- |
| v0.5.1-01.1 · SLOs · Start with a product | Browse 20 product templates or add a custom goal. Suggested targets remain editable. |
| v0.5.1-01.2 · SLOs · Goals | The same two custom goals and three Event ticketing goals used in the Guide. Mixed results and coverage states. |
| v0.5.1-01.3 · SLOs · Add a goal | Plain-language success, scope, exclusions, target and window. Empty preview until measurements are available. |
| v0.5.1-01.4 · SLOs · Request timing | Orders finish quickly: 99.9% below 500 ms; errors and interruptions miss the goal. |
| v0.5.1-01.5 · SLOs · Goal detail | Checkout goal, complete coverage, allowance, burn, failure explanations, version and freshness. |
| v0.5.1-01.6 · SLA · Complete month | Full October UTC period, versioned example agreement and request-based counts. |
| v0.5.1-01.7 · SLOs · Product templates | Shared Guide drawer: search, product/project selection, recommendations and pagination. |
| v0.5.1-01.8 · SLOs · Review template goals | Select goals, edit suggested targets and add three goals while retaining existing goals. |
| v0.5.1-01.9 · SLOs · Goal details | Review/edit project, source, matching route, eligibility, correctness, timing and window. |
| v0.5.1-01.10 · SLOs · Job goal | Logical jobs counted once, queue acceptance through confirmed completion, including waits and retries. |
| v0.5.1-01.11 · SLOs · Goals added | Confirmation, waiting-for-measurements state, Undo and View goals. |
| v0.5.1-01.12 · SLOs · Coverage unavailable | Missing interval and source; result, allowance and burn withheld. |
| v0.5.1-01.13 · SLOs · No eligible work | Complete coverage with zero work; no fabricated 100% result. |
| v0.5.1-01.14 · SLA · Incomplete month | Partial coverage and counts; exports clearly marked draft, with no certified monthly result. |

The compact states sit below the existing SLO screens. The template browser and goal review reuse the Guide components. Goal creation does not itself supply measurements; scope/mapping and timing must be reviewed before measuring. A successful worker return does not establish queue completion.

## Verification and fixture arithmetic

- Read the text/structure of 57 previously updated Stream, Flow, Sources and Guide screens for old logging terms and inconsistent schema claims.
- Visually reviewed the 23 Search/export and SLO/SLA states for spacing, typography, contrast, alignment, repeated rows and fit. Fixed the CSV dialog wrapping and overflowing SLO descriptions.
- Failure badges and status dots agree. There is no Success log level, new calls array, outcome field or wideEvents wrapper.
- The large-event inspector retains its explicit custom-size-limit example; nested provider fields preserve their original names and types.
- Search example: seven matching events in five correlated groups.
- SLO detail: 8,400 eligible = 8,224 good + 176 missed. Target 99% allows 84 misses: 97.9047619% achieved, 92 misses beyond allowance and −109.5238095% remaining.
- Chart fixture: the first 28 daily buckets contain 200 eligible requests and one miss each; bucket 29 contains 400 and one; bucket 30 contains 2,400 and 147. The allowance chart uses the same accumulated counts.
- Burn fixture at the final point: 1h 71/500 = 14.2×; 5m 8/50 = 16×; 6h 136/2,000 = 6.8×; 30m 18/250 = 7.2×, against a 1% allowance. The fast rule does not fire because both windows must exceed 14.4×; the slow rule fires because both exceed 6×. Earlier burn-chart points are illustrative synthetic values.
- Complete SLA example: 1,000,000 eligible, 999,400 good, 600 bad; 99.94% against 99.9%, with 1,000 allowed and 400 remaining. October 7 has 480 failed requests, October 22 has 120; no automatic maintenance exclusion or downtime conversion.
- Incomplete SLA is a separate fixture: collection starts October 4; 920,000 observed requests do not establish a complete-month result.
- Paper’s size warning cleared before this pass resumed. No warning remained on the final page checks. Full-screen review copies from the blocked attempt were removed; existing screens were updated in place.

All counts, traffic, routes and agreement terms are synthetic review data. These are static Paper designs, not an interactive or deployed application. Real copy/export behavior, pre-storage redaction, queue integration and durable unsampled SLO/SLA measurement still require implementation. No application or language-example code changed in this design pass.

The [guide](logging-guide.md), [product templates](logging-product-templates.md), [proposal](logging-proposal.md), [use cases](logging-use-cases.md) and [language references](../examples/logging/README.md) remain the implementation handoff.

## Alignment pass — 23 November 2026

Design-only fixes made before implementation starts. No app code changed.

**quiet · v1.1 storage & retention → 02 · historical investigation**

- v1.1-19 and v1.1-22: the `settle_dealer_payout` job is now grouped under its request `req_8f2a60` ("5 events in 2 flows"), matching the Flow page. Result rows use fixed lanes (summary 420 px · match chip 110 px · meta), so `dealer_id:88` lines up across rows. The summary follows the guide (`fetch_payouts · GET … → 200`, `settle_dealer_payout · attempt 0 → timeout`). Path text is no longer highlighted as if it were the field match.
- v1.1-19, 21, 22: the histogram marks "No retained history before 09 Nov". On v1.1-21, "Garage not searched" now covers only 09–21 Nov.
- v1.1-20: Garage covers 09–21 Nov; 8 of 13 days = 62%, with a matching bar.
- v1.1-21: Garage failed, so the result is now a 22 Nov event from production-r2 (`req_9c1e04`) instead of the 12 Nov Garage event.
- v1.1-23 and v1.1-26: the field card matches search: `warn` at 14:07:24.412, service `legivent-api`. Job execution reads "Exec 3.5 s" (800 + 640 + 2100 ms); 9.6 s is total elapsed time including backoff. Job id `payout-88-1300` on queue `payouts`, as in the portal file.

**portal v0.1.0 → v0.1.0 · 11 · How to use**

- v0.1.0-11.3 and v0.1.1-11.5: `route` moved into `request` (guide: `request.route`) and `"job_id": null` removed (omit absent fields). The v0.1.1 example and the generated prompt use `"order": { "id": … }`. The field legend reads "Stream · Flow" and "Timing" instead of "Flow node" and "Waterfall".
- v0.1.0-11.7: the error-object fix line now reads 1,568 stringified errors (214 of 1,782 are objects).
- v0.1.1-11.1: "3 steps · 2 rules"; "Keep 10% · changed from the 100% default".
- v0.1.1-11.8: product type drives the recommendation, not a filter; the hint now says "see all 20 templates".

**Job id convention:** designs use the queue's native id plus scope, `job_id: "payout-88-1300"` with `queue: "payouts"`. The old prompt and `server/src/lint.rs` fix text still say `payout:88:1300`; update them during implementation.

## What's new markers — 23 November 2026

New Paper page **v0.1.1 · 00 · What's new** (portal v0.1.0) shows existing users what changed and gives a path for code already instrumented with the v0.1.0 prompt.

| Screen | Behavior |
| --- | --- |
| v0.1.1-00.1 · first visit after upgrade | Version chip `v0.1.1` with an unseen dot; `updated` on Guide and its changed tabs; a one-time banner: logs you already send keep working, 2 sources still use the v0.1.0 format, What changed / Check my sources. |
| v0.1.1-00.2 · sheet | What's new sheet: "Changes to your logs" (event shape, request/response context, `[REDACTED]`, levels and job ids), an old-format sources callout, "Changes to quiet" (5 app changes), Mark all as seen. |
| v0.1.1-00.3 · upgrade a v0.1.0 source | Per-source field map (what your code writes → what v0.1.1 expects, with record counts from the 5,000-record sample), a changes-only upgrade prompt, and rollout progress after deploy. Sidebar shows `· v0.1.0` on old-format sources. |
| v0.1.1-00.4 · marker rules | `new` / `updated` / unseen dot / old-format source tag; who sees them, when they clear (per account), roll-up, one marker per item, accessibility. |

Implementation notes: one release manifest (id · new|updated · target · summary) feeds the sheet and every marker; seen state is stored per account; the v0.1.0 source tag is derived from received records (v0.1.0-only fields such as `outcome`, `wideEvents.calls`, `msg` without `flow`, `status` without `status_code`) and clears after 24 h without them.
