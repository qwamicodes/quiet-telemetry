# Product SLO templates

Proposed Guide content and template definitions. These are editable starting suggestions for setup, not published industry benchmarks or contractual commitments. Review them against the product's users, dependencies and observed performance before rollout.

Templates group goals around customer workflows, following the [Google SRE Workbook's guidance on user journeys and SLOs](https://sre.google/workbook/implementing-slos/). The names, numerical targets and product examples below are proposed for quiet. They do not change the agreed wide-event middleware convention.

## Product library

20 product packs · 60 suggested goals. Search by product name or browse the full library; recommendations use the project's selected product type.

1. Payment system
2. Food ordering app
3. Event ticketing
4. Buy now, pay later
5. Digital wallet & transfers
6. E-commerce store
7. Multi-vendor marketplace
8. Subscription & membership
9. Ride-hailing
10. Courier & parcel delivery
11. Travel & accommodation booking
12. Appointments & reservations
13. Healthcare patient portal
14. Online learning platform
15. Team collaboration & project management
16. Messaging & community
17. Video & live streaming
18. Online gaming
19. AI assistant & automation
20. IoT & connected-device platform

## How the setup works

1. Choose a project and its product type. Use the selected product type to recommend a pack; keep every pack accessible under All templates.
2. Open a product pack to see its recommended goals. Select only the goals the product needs.
3. Edit each goal's name, scope, target, time limit and reporting period. More options exposes success rules, exclusions and the measurement boundary.
4. Add the selected goals together. Keep existing goals unchanged. When the same goal and scope already exist, offer to edit that goal rather than silently duplicating it.
5. Show the added goals and one Undo action for this addition. Undo removes only the new goals.
6. Include all selected definitions in the generated prompt. Map workflows to actual services, routes, queues and business signals in the codebase. An unresolved mapping or missing measurement coverage remains unverified.

Each pack has three goals. All suggestions use a rolling 30-day period. “Under” means strictly less than the limit; “within” includes the boundary. The target percentage is the fraction of eligible units meeting the stated good condition.

## Payment system

Help customers get a clear payment result and keep the application informed.

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Payments reach a clear result / `payments-result` | 99.9% within 60 seconds | One valid automatic payment attempt, from server acceptance for processing to a persisted, authoritative final result | A confirmed success or correctly handled business decline is recorded within the limit |
| Checkout feels fast / `payments-checkout` | 99% under 2 seconds | One valid checkout API submission, from request start to local response-body completion | A correct response or next-action instruction completes without a technical failure within the limit |
| Payment updates reach your app / `payments-updates` | 99.9% within 60 seconds | One authoritative payment update required by the application, from its occurrence at the provider to the application's verified, durably persisted acknowledgement | The matching update has been received and stored within the limit, including retries |

For `payments-result`, start only when required customer authentication/actions are complete and automatic processing can begin. Human interaction time is outside this unit. A legitimate issuer decline is a valid final result; a timeout, unknown result or processing outage is a miss. Require durable accepted-attempt and deadline evidence so an attempt with no final record cannot disappear from the denominator.

For `payments-checkout`, use the application's actual list of correct responses, including required authentication steps and business declines. This measures the server response, not the customer's completion of payment.

For `payments-updates`, correlate the provider's authoritative event identity and timestamp with receiver acknowledgement. Duplicate deliveries do not create extra units. Provider/receiver outages and delivery retries remain in scope. Without a reliable inventory of expected provider events, report incomplete coverage rather than claiming a delivery SLO from received webhooks alone.

## Food ordering app

Help customers submit orders, see confirmation and reach the restaurant's ordering system.

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Orders reach the restaurant / `food-order-delivery` | 99.9% within 30 seconds | One accepted customer order, from durable acceptance to acknowledgement by the restaurant's ordering system | The correct order is durably acknowledged by that system within the limit |
| Order confirmations are ready / `food-confirmation` | 99.9% within 10 seconds | One accepted customer order, from durable acceptance to confirmation being available in the customer's app | The correct order confirmation is stored and available within the limit |
| Menus load quickly / `food-menu` | 99% under 1 second | One valid menu API request, from request start to local response-body completion | A correct, usable menu response completes without a technical failure within the limit |

Restaurant-system acknowledgement does not mean a staff member accepted or prepared the order. The delivery goal measures reliable software delivery; restaurant decision time needs a separately chosen operational goal. Include waiting and retries. Rejected orders that were never accepted are outside the first two units; once accepted, cancellations and subsequent delivery/confirmation failures remain in scope for these starting definitions.

Confirmation availability is separate from push notification, SMS or email delivery. Those channels need their own acknowledgements and goals if selected. The menu suggestion measures the server boundary; it does not claim to measure device rendering or the entire screen-load experience.

## Event ticketing

Help customers check out, get their paid tickets and enter the venue.

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Checkout feels fast / `tickets-checkout` | 99% under 2 seconds | One valid ticket-checkout API submission, from request start to local response-body completion | A correct response completes within the limit; correctly handled sold-out responses and payment declines are valid results |
| Paid tickets are ready / `tickets-ready` | 99.9% within 30 seconds | One logical paid order, from authoritative payment confirmation to ticket availability | The correct tickets are persisted and accessible to the buyer within the limit |
| Check-in stays fast / `tickets-checkin` | 99.9% under 1 second | One valid online ticket-scan API request, from request start to local response-body completion | The correct admit/reject decision completes within the limit |

Checkout technical errors, interrupted responses and time-limit misses are bad. Do not count all non-purchases as technical failures: a correct sold-out response or legitimate payment decline can meet this responsiveness goal.

For paid-ticket issuance, include queue waiting and retries. Count the logical paid order once, regardless of ticket quantity, worker attempts or duplicate payment notifications. A worker returning is not proof that tickets are accessible. Cancellation or refund after payment does not silently remove the paid order; failure to make tickets available by the deadline is bad for this starting definition. Track paid orders durably through their deadlines, including those without an issuance event.

For check-in, a correct rejection of an invalid or already-used ticket is good when it meets the time limit. Technical failures and aborted scans are bad. Offline scans are outside this online goal and require a separately defined offline experience/synchronization goal.

## Buy now, pay later

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Eligibility checks respond / `bnpl-eligibility` | 99% under 3 seconds | One valid automated eligibility-check request, from server request start to local response completion | A correct approval, decline or next-action/review response completes within the limit |
| Payment plans are ready / `bnpl-plans` | 99.9% within 10 seconds | One provider-confirmed financing agreement after required customer acceptance, from authoritative confirmation to plan availability | The correct agreed amounts, installments and dates are durably stored and available |
| Repayments update the balance / `bnpl-repayments` | 99.9% within 60 seconds | One authoritative posted repayment, from provider posting time to durable local reconciliation | The correct installment and remaining balance reflect the repayment exactly once |

Measure software responses, not approval rates, creditworthiness or repayment behavior. Human authentication, acceptance and manual underwriting are outside the eligibility request boundary. Correct declines count as handled responses. Start plan timing only after provider confirmation and customer acceptance. Require authoritative expected repayment records, scoped native IDs and duplicate handling; do not measure reconciliation only from received notifications. Use plan/balance goals only when the integration exposes the needed data. Provider-side timing and observations must be verified. The [Stripe BNPL integration overview](https://docs.stripe.com/payments/buy-now-pay-later) describes the customer/provider checkout sequence; these numerical SLOs are quiet proposals.

## Digital wallet & transfers

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Balances load quickly / `wallet-balance` | 99% under 1 second | One valid authenticated balance API request, from request start to local response completion | The correct balance at the authoritative ledger revision is returned within the limit |
| Internal transfers are recorded / `wallet-transfers` | 99.9% within 5 seconds | One accepted internal-wallet transfer, from durable acceptance to ledger commitment | The matching debit and credit are correctly committed once and visible within the limit |
| External transfer updates appear / `wallet-updates` | 99.9% within 60 seconds | One authoritative external-transfer status change, from provider event time to local durable visibility | The correct status is reflected within the limit |

The internal-transfer goal applies only to transfers between balances controlled by this product. External bank settlement needs its own provider-specific boundary. Correct balance reads require a ledger reference; matching two replicas alone does not prove correctness. Require an authoritative inventory of external status changes.

## E-commerce store

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Product pages get their data quickly / `commerce-catalog` | 99% under 1 second | One valid product-detail API request, from request start to local response completion | A correct product and availability response completes within the limit |
| Paid orders are recorded / `commerce-orders` | 99.9% within 10 seconds | One authoritatively confirmed payment for an order, from confirmation to durable order visibility | The matching order is correctly recorded once and available to the customer |
| Stock updates reach the storefront / `commerce-stock` | 99.9% within 30 seconds | One committed stock change, from inventory commit to storefront read-model availability | The storefront reflects that inventory revision within the limit |

Count paid logical orders once across callbacks and retries. Product-data latency is the server response boundary. Stock freshness measures propagation, not a guarantee of no overselling; reservation and consistency controls remain necessary independently of this SLO.

## Multi-vendor marketplace

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Listings are easy to find / `marketplace-search` | 99% under 1 second | One valid listing-search API request, from request start to local response completion | A correct search response completes within the limit |
| Orders reach the seller / `marketplace-seller` | 99.9% within 30 seconds | One accepted marketplace order, from durable acceptance to seller-system acknowledgement | The correct order is durably acknowledged by the seller integration |
| Payout updates are visible / `marketplace-payouts` | 99.9% within 60 seconds | One authoritative payout status change, from provider event time to seller-visible durable state | The seller sees the correct status within the limit |

Seller acknowledgement means software receipt, not a human promise to fulfil. Provider payout settlement can take much longer than status propagation; this template measures the latter. Use authoritative payout events and durable delivery records, including those that never arrive locally.

## Subscription & membership

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Paid members get access / `subscriptions-access` | 99.9% within 30 seconds | One confirmed paid subscription activation, from payment confirmation to entitlement availability | The correct membership entitlement is active and readable within the limit |
| Renewal invoices are ready / `subscriptions-invoices` | 99.9% within 5 minutes | One eligible scheduled renewal, from its due timestamp to durable invoice availability | The correct renewal invoice exists once within the limit |
| Cancellation choices are saved / `subscriptions-cancellations` | 99.9% within 5 seconds | One accepted cancellation request, from server acceptance to durable subscription update | The requested cancellation or end-of-term setting is correctly saved and confirmed |

Use the durable renewal schedule as the invoice denominator, including renewals with no job log. Invoicing does not imply successful collection. Cancellation timing measures saving the requested policy, not ending access immediately when the customer chose end-of-term cancellation.

## Ride-hailing

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Fare estimates respond quickly / `rides-quotes` | 99% under 2 seconds | One valid fare-quote API request, from request start to local response completion | A correct quote or supported no-service response completes within the limit |
| Ride requests reach dispatch / `rides-dispatch` | 99.9% within 5 seconds | One accepted ride request, from durable acceptance to dispatch-system acknowledgement | Dispatch durably receives the correct request within the limit |
| Trip updates reach the app / `rides-trip` | 99% within 5 seconds | One accepted trip-state update, from backend receipt to customer-facing state availability | The correct ordered trip state is available within the limit |

Dispatch delivery does not promise a driver match or pickup time. Measure travel operations separately. Trip-update timing starts at backend receipt; device/network gaps before receipt require separate coverage rather than an assumed healthy feed.

## Courier & parcel delivery

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Shipping labels are ready / `delivery-labels` | 99.9% within 30 seconds | One accepted label-generation task, from durable acceptance to valid label availability | The correct carrier-accepted label is stored and accessible |
| Tracking updates are visible / `delivery-tracking` | 99.9% within 60 seconds | One authoritative carrier tracking event, from carrier event time to customer-facing durable state | The correct tracking state is available within the limit |
| Delivery proof is saved / `delivery-proof` | 99.9% within 10 seconds | One complete valid proof upload, from full server receipt to durable read-back availability | The correct proof and parcel association can be read back |

Label availability does not imply collection or physical delivery. Tracking requires an expected-event inventory or reconciliation feed. Proof timing begins after upload receipt; upload/network time needs a separate goal if important.

## Travel & accommodation booking

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Availability searches respond / `travel-availability` | 99% under 2 seconds | One valid availability-search API request, from request start to local response completion | A correct available/unavailable response completes within the limit |
| Confirmed bookings are ready / `travel-booking` | 99.9% within 30 seconds | One supplier-confirmed booking, from authoritative supplier confirmation to customer availability | The matching itinerary or reservation confirmation is durably accessible |
| Cancellation requests reach the supplier / `travel-cancellation` | 99.9% within 60 seconds | One valid cancellation request accepted for delivery, from acceptance to supplier acknowledgement | The supplier durably acknowledges receipt within the limit |

Supplier confirmation and payment are different facts; do not infer a reservation from a payment alone. Cancellation acknowledgement does not prove the supplier approved cancellation or issued a refund.

## Appointments & reservations

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Available slots load quickly / `appointments-slots` | 99% under 1 second | One valid slot-search API request, from request start to local response completion | A correct availability response completes within the limit |
| Bookings are confirmed / `appointments-booking` | 99.9% within 5 seconds | One accepted available-slot booking, from durable acceptance to confirmation visibility | The correct reservation is committed once and visible to the customer |
| Reminders reach the sending service / `appointments-reminders` | 99.9% within 60 seconds | One eligible scheduled reminder, from its due time to sending-provider acknowledgement | The correct reminder is accepted for sending within the limit |

Use authoritative booking/slot state to verify success; a 200 response alone does not establish reservation correctness. Reminders use the persisted schedule as denominator. Provider acceptance does not prove delivery to a phone or inbox.

## Healthcare patient portal

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Authorized records are available / `health-records` | 99% under 2 seconds | One valid authorized patient-record API request, from request start to local response completion | The correct permitted record response completes within the limit |
| Patient messages reach the care inbox / `health-messages` | 99.9% within 10 seconds | One accepted patient message, from durable acceptance to care-team inbox availability | The correct message and recipient association are durably available |
| Released results reach the portal / `health-updates` | 99.9% within 60 seconds | One result explicitly released for patient access, from authoritative release to portal availability | The correct released result is accessible to its authorized patient |

These are portal software goals. They do not define clinical response times, emergency handling or medical correctness. Unreleased results are outside the release unit; delayed propagation after release is in scope. Availability measurement must never bypass authorization.

## Online learning platform

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Lesson content opens quickly / `learning-lessons` | 99% under 2 seconds | One valid authorized lesson-content API request, from request start to local response completion | The correct lesson metadata/content response completes within the limit |
| Learning progress is saved / `learning-progress` | 99.9% within 5 seconds | One accepted progress update, from server acceptance to durable read-back | The correct learner/course progress is persisted and readable |
| Assignment submissions are confirmed / `learning-submissions` | 99.9% within 10 seconds | One complete valid submission received before the configured cutoff, from full receipt to durable confirmation | The submission and attachments are correctly stored and confirmed |

Lesson API timing excludes video playback and rendering. Submission timing starts after full upload receipt; due-date rules are explicit eligibility rules. Grading quality and grading turnaround need separate objectives.

## Team collaboration & project management

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Workspaces load quickly / `collaboration-workspaces` | 99% under 1 second | One valid authorized workspace API request, from request start to local response completion | The correct workspace response completes within the limit |
| Edits are saved / `collaboration-edits` | 99.9% within 2 seconds | One accepted task/document edit, from server acceptance to durable revision commit | The correct edit or correctly resolved version-conflict response completes within the limit |
| Changes reach connected teammates / `collaboration-sync` | 99% within 5 seconds | One committed change for a continuously connected subscribed client, from commit to client acknowledgement | The authorized client acknowledges the correct revision within the limit |

Use revision identities to check edits and synchronization. Correct conflict resolution can meet the edit goal; lost edits cannot. Synchronization requires client acknowledgements, and disconnects after eligibility begins count as misses for this starting definition. Already-offline clients need a separate catch-up goal.

## Messaging & community

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Messages are saved / `messaging-send` | 99.9% within 2 seconds | One accepted message, from server acceptance to durable message acknowledgement | The correct message is persisted once with the expected conversation association |
| Messages reach connected recipients / `messaging-receive` | 99% within 5 seconds | One persisted message/continuously connected recipient pair, from commit to recipient acknowledgement | The intended authorized recipient acknowledges the message within the limit |
| Conversation history loads quickly / `messaging-history` | 99% under 1 second | One valid authorized history API request, from request start to local response completion | The correct ordered history response completes within the limit |

Connected-recipient timing needs receipt evidence from the receiving client. A server emit is not delivery. Exclude recipients already offline at start; a disconnect during the measured interval is a miss under this starting definition. Human reading is outside scope.

## Video & live streaming

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Playback starts quickly / `video-start` | 99% within 3 seconds | One supported online playback attempt, from client play action to first rendered frame | A valid first frame is rendered within the limit |
| Playback keeps moving / `video-continuity` | 99% of sessions meet the stall budget | One started playback session with complete player telemetry | Total unrequested rebuffering is at most 1% of active playback time; exclude user pauses and seeking |
| Live playback stays near real time / `video-live` | 99% within 10 seconds | One predefined once-per-second eligible live-playback sample, from source capture timestamp to frame presentation | Measured live delay is at most 10 seconds |

These goals need player telemetry and reliable source/client time alignment. Use a fixed sampling schedule independent of success. Track attempts and sessions with missing telemetry as incomplete coverage rather than dropping them. Decode failures and involuntary playback termination are bad continuity sessions, even if rebuffering duration alone is small. Supported content, devices and networks must be chosen explicitly.

## Online gaming

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Game sessions start / `gaming-sessions` | 99% within 10 seconds | One valid start-session request for a supported game mode, from acceptance to a playable-session acknowledgement | The correct assigned session becomes playable within the limit |
| Player progress is saved / `gaming-saves` | 99.9% within 2 seconds | One accepted progress save, from server acceptance to durable revision acknowledgement | The correct player progress revision is committed once |
| Purchased items reach the inventory / `gaming-purchases` | 99.9% within 30 seconds | One confirmed item purchase, from authoritative payment confirmation to inventory availability | The correct purchased entitlement is available once |

Playable session startup requires client/session acknowledgement; process creation alone is insufficient. Matchmaking fairness, player-population waiting and in-game network quality need explicit separate goals. Do not use this starter for unbounded competitive queues without adapting its scope.

## AI assistant & automation

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Answers start promptly / `ai-start` | 99% under 3 seconds | One valid supported online assistant request, from server request acceptance to first user-visible meaningful output | Useful answer text or an appropriate product response appears within the limit, not an empty keepalive |
| Responses complete reliably / `ai-finish` | 99% within 30 seconds | One eligible interactive answer request, from server acceptance to valid final completion | The response finishes correctly as a transport/workflow result without a technical error |
| Approved actions report a result / `ai-actions` | 99.9% within 60 seconds | One supported action explicitly approved by the user and durably accepted, from acceptance to confirmed result availability | The actual external action result or correct business rejection is recorded and shown |

Use bounded request/action classes; long-running workflows need separate targets. Policy refusals can be appropriate completed responses, and are not model outages. These goals measure delivery/workflow reliability, not factual accuracy or quality. Tool acknowledgements must prove the real action result; do not retry non-idempotent actions blindly. Keep model/provider failures in scope.

## IoT & connected-device platform

| Goal / template key | Suggested target | Eligible unit and timing | Good result |
| --- | --- | --- | --- |
| Received readings become visible / `iot-telemetry` | 99.9% within 10 seconds | One valid reading received by the gateway, from gateway receipt to durable query availability | The correct device-scoped reading is stored and queryable |
| Online devices acknowledge commands / `iot-commands` | 99% within 5 seconds | One accepted command for a device known online at acceptance, from durable acceptance to matching device acknowledgement | The device acknowledges the intended command within the limit |
| Rule alerts reach the delivery service / `iot-alerts` | 99.9% within 30 seconds | One qualifying condition in an authoritative expected-evaluation stream, from condition eligibility to alert-provider acknowledgement | The correctly routed alert is accepted by the configured delivery service |

Gateway timing excludes disconnected-device periods before receipt; end-to-end sensor freshness needs an expected-reading inventory. Command acknowledgement does not necessarily prove physical actuation. Devices disconnecting after command acceptance count as misses. Alert-provider acceptance does not prove human awareness; distinguish missing sensor/evaluation coverage from no alert-worthy condition.

## Shared measurement and logging rules

- Use production traffic. Exclude test traffic; exclude malformed submissions from request-based units. Exclusions must be explicit in the generated prompt and visible under More options. Do not silently exclude provider outages, retries or missing successful completions.
- Use actual business result evidence to distinguish valid rejections from technical failures. Preserve the codebase's native fields and identifiers; these template keys are configuration metadata, not new mandatory log fields.
- Measure all eligible work before log sampling. Request goals can use unsampled bounded metrics. Cross-step delivery/issuance goals need durable lifecycle and deadline records. Missing observation coverage is unknown; a known unit that definitively misses its deadline is bad.
- Keep severity and retention rules unchanged. For example, HTTP 400 can still be an error-level retained log even when an explicitly defined, correctly handled business rejection meets a product goal.
- Keep every observed event that misses an applicable goal, along with the other agreed mandatory retention cases. Do not fabricate an execution-completion event when only a deadline or missing-worker observation exists.
- Evaluate overlapping goals separately. One event may contribute to several goals without duplicate emission or summing their denominators.
- Keep the routine-log sampling rate separate from reliability targets. Product templates do not change capture, redaction or sampling settings automatically.
- SLA terms require the user's actual agreement and reporting period. Selecting a product pack does not create an SLA.

## Current Paper walkthrough

The example project has two existing goals: Orders finish quickly and Jobs finish on time. The user selects all three Event ticketing goals and adds them together. The resulting setup and prompt contain five independent goals. The other 19 product packs remain available for other projects or additional selections; they are not silently included in this example's prompt. The library shows three packs per page, with search and a recommended view. A separate BNPL review state demonstrates its three goals without applying them to this project.

The codebase agent must resolve the selected ticket-checkout, paid-order/ticket-availability and online check-in workflows to real instrumentation. Do not guess routes from the existing order-request example. Report any missing bindings, lifecycle coverage or unverified checks before claiming the goals are measured.
