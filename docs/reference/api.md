# HTTP API

The UI uses exactly this API. Request and response types are defined in Rust and exported to `web/src/gen/` (`make types`), which is the most precise reference for field names.

Every `/api` route needs a session cookie except the public auth routes, and every non-GET request also needs the `X-Quiet-Csrf` header (see [Accounts](accounts.md)). Without a session: `401 { error, code: "session_required" | "session_expired" }`. `/health`, `/ready` and the ingest endpoints don't use sessions. Owner-only routes answer members with 403 `owner_only`; bad values get 400 `invalid`.

## Health and sources

- `GET /health` (liveness) · `GET /ready` (readiness, 503 while shutting down)
- `GET /api/health`: version, `retention_ms`, `disk_bytes`, `stored_lines`, `oldest`, and `ingest: { auth, loopback, max_body, rate, tokens }`
- `GET /api/about`: version, commit, build date, start time, store kind, SQLite version, database size, data dir, live clients, member count, Docker status (Settings → About)
- `GET /api/sources`: every source, with `display_name`, `hidden`, `paused`, its group, `format` (`v0.1.0` while an old-format record arrived in the last 24 h, else `v0.1.1` once a canonical event has, else absent) and `id_key` (the id key its newest rows show, since the server started) · `GET /api/sources/grouping-preview`: how sources would group under each mode
- `GET /api/sources/:name/lines?limit=`: the newest lines of one source
- `GET /api/sources/:name/fields?sample=2000`: fields detected, flow ids, malformed lines, and `level_scheme` (`pino` numbers, `names`, `mixed` or `none`)
- `GET /api/sources/:name/activity` → `{ rejections, rejected_15m, paused_dropped, dropped, dropped_24h }`. `dropped` lists dropped or cut records per minute, newest first, last 24h: `{ minute, source, reason: text_policy | parse_limit | size_limit | duplicate_key, stored, count, bytes }`. Payloads are never kept.
- `GET /api/sources/:name/lint?sample=1000`: **Check my logs**, the newest records scored against the canonical completion event → `{ source, sampled, passed, applicable, checks: [{ id, title, status: pass|warn|fail|review|optional|na, share, detail, fix, failing }] }`. `failing` holds up to 3 records the check missed, `{ line_id, ts, note, excerpt }`; the excerpt is redacted again and cut to 320 characters
- `GET /api/sources/:name/format`: the newest 5,000 records against the v0.1.1 contract, for the upgrade screen → `{ source, sample, old, new, other, tag, last_old, last_new, changes: [{ id, from, to, count, old_format }], rollout: [{ start, old, new }], now }`. A record is v0.1.0 when it carries `outcome`, `wideEvents.calls`, `msg` without `flow`, or `status` without `status_code`; `err` and `job_id` without `queue` are listed as advice.
- `POST /api/sources/:name/remove {"confirm":"<name>","revoke_tokens":true}` (owner): pause + hide the source, delete its stored lines and revoke the ingest tokens bound to it; returns `{ lines, revoked, previous }` (Undo = restore each token within 60 s + `PUT` the previous settings)
- `GET /api/id-coverage?keys=a,b&sample=2000`: how often each id key appears, across sources
- `GET /api/system` → `{ ok, issues: [{kind, severity, title, detail}], docker, disk, ingest, store, now }` (the system banners). `docker` is `{ state: "connected", containers, endpoint, engine }`, `{ state: "unavailable", error, retry_at, attempt }` (the next reconnect, unix ms, and failed attempts in a row), `connecting` or `disabled`; `/api/health` carries the same object

## Stream

- `WS /api/stream?source=&backlog=&level=&q=` → frames `backlog`, `lines` (batched every 75 ms), `gap` (client fell behind). The upgrade must be same-origin; the stream re-checks its session every 30 s and closes with code 4401 once it ends.
- `GET /api/stream/stats?source=&q=&window=`: level chips, volume histogram and totals, counted in the store.

## Search and export

- `GET /api/search?q=&source=a,b&level=&since=&until=&id=&order=newest|oldest&cursor=&limit=&buckets=` → `{ lines, next_cursor, total, bytes, histogram, searched, took_ms, since, until, history? }`. Times are unix ms; missing bounds = the retention window ending now. `history` (first page, only when `since` was given and the range reaches past the local window, once retained history has been used): `{ from, to, hours, archived, destinations: [{ id, name, active, first, last, hours, percent }], gaps: [{ from, to, reason }], expired_before, auto, truncated }`. `total`/`histogram` come with the first page when `buckets` is set. Query language: [Search](how-it-works.md#search).
- `GET /api/export?<search params>&format=ndjson|json|csv&gzip=1&mask=pii&raw=1&columns=a,b&muted=include|hide|auto` streams a file (oldest first). `muted=hide` leaves out lines matching their source's muted-lines rules, `auto` does so per source as search does by default; without it every line is kept. With `Authorization: Bearer qx_…` it needs no session (the token is the credential). Members always get PII masked.
- `POST /api/export/token {"query":"<export query string>"}` → `{ token, expires_at, path }`: a read-only `qx_` token for that one query, reusable for 15 minutes; only its SHA-256 is kept (in memory). Members only get one for a masked query (`mask=pii`), else 403 `mask_required`.
- `POST /api/export/jobs {"query":"<export query string>"}` → `202 { id, state, done, total, … }`: the server prepares a very large export (the UI uses it over ~100k lines). Poll `GET /api/export/jobs/:id` (`preparing` → `ready` | `failed`; `done`/`total`/`eta_ms`), fetch `GET /api/export/jobs/:id/download` once ready, `DELETE` to cancel or discard. Session only, owner of the job only; members always masked; files kept an hour in `<data dir>/exports`. The retention window waits while a job prepares.

## Flows

- `GET /api/flow?id=<any id>` or `?line=<line id>` → `{ flow, since, until, took_ms, history? }` (`history`: `{ since, until, found }` when the flow may continue in retained history that wasn't loaded): `flow` has the header numbers (`title`, `status`, `line_count`, `steps`, `sources`, `duration_ms`, `retries`, `stitched_by`, `truncated`), `nodes`, `edges`, the `lines` themselves, `missing_parent` (a request id the jobs carry whose own line isn't in the window) and `partial`. Unknown id → 404 `{ error, id, close: [{ key, value, msg, ts, source }] }` (ids with the same prefix). Ids go in the query string, so any id works.
- `POST /api/flow-summaries {"ids":[…]}` (≤ 100) → `{ flows: [{ id, flow: <header numbers> | null }] }`; ids of one flow share its `key`.

## Settings and storage

- `GET /api/settings` → `{ general, storage, grouping, flow_ids, sources, muted_global, muted_search }` (any signed-in user)
- Owner only:
  - `PUT /api/settings/general {instance_name, stream_direction, timezone, public_url, timestamps, max_line_bytes, keep_non_json, check_updates, search_include_muted}`
  - `PUT /api/settings/storage {retention_ms?: number|null, max_disk?: number|null}` (`null` = use the flag)
  - `PUT /api/settings/grouping {mode, label} | null` (`null` = auto; 400 when `QUIET_GROUP_BY` / `QUIET_GROUP_LABEL` lock it)
  - `PUT /api/settings/flow-ids {order, match_by}`
  - `PUT /api/settings/sources/:name {display_name, hidden, paused, retention_ms, id_keys, default_level, mask_fields, unmasked, redact_fields, redact_pii, exclude_history, muted, search_include_muted, muted_global_off}` · `DELETE /api/settings/sources/:name` (back to instance defaults)
- `GET /api/storage` → `{ settings, store, path, used, ratio, lines, oldest, fs_free, hours: [{start, lines, bytes}], sources: [{source, lines, bytes, disk, share}], bytes_per_hour, steady_bytes, cap_in_ms, now }`
- `POST /api/storage/purge {source?, confirm}` (owner; `confirm` = `purge`, or the source name) → `{ lines, source }`

## Retained history

Secrets are write-only: responses carry `access_key_preview`, never the secret.

- Searching retained history (session; jobs are per user, in memory):
  - `POST /api/search/history {"query":"<search query string>"}` → `202` the job: `{ id, state: retrieving|done|cancelled|incomplete, done, total, bytes, downloaded, matched, lines, locations: { <line id>: <destination> }, histogram, failures: [{ destination, from, to, hours, error }], coverage, created, offset, count }`. 400 `nothing_to_search` when no archived hour falls in the range.
  - `GET /api/search/history/:id?offset=&limit=` (≤ 1000) → the job with that page of matches (newest first).
  - `DELETE /api/search/history/:id` → cancels; what was found stays.
  - `GET /api/search/history/:id/export?format=ndjson|json|csv&gzip=1&mask=pii&raw=1&columns=` → the job's matches as a file (oldest first; 409 `retrieving` while it runs). Members always get PII masked.
- `GET /api/storage/history` → `{ enabled, enabled_at, instance_id, active, destinations, gaps: [{ hour, reason, at }] (newest 100), gap_hours, waiting_hours, policy, retained_from, expired_hours, expired_bytes, backfill_hours, jobs (newest 20) }`. `reason`: `no_destination` · `destination_unavailable` · `disk_cap` · `excluded` · `at_capacity`. `retained_from`: archived hours older than this are deleted (`null`: kept indefinitely); `expired_*`: hours past it still to delete; `backfill_hours`: complete local hours the active destination doesn't hold. A job: `{ id, kind: backfill|copy|delete, state: running|blocked|done|failed|cancelled, destination_id, destination, source_id, source, total, done, bytes, error, next_retry, created_at, updated_at }`.
- `GET /api/storage/destinations` → `{ destinations: [{ id, name, kind, endpoint, region, bucket, prefix, path_style, access_key_preview, active, state, verified_at, last_verify, hours, lines, bytes_stored, first, last, error, next_retry, created_at, capacity_bytes, capacity_source: owner|garage|null, at_capacity, removing, cleanup_error, cleanup_retry_at, cleanup_blocked_hours }] }`. `kind`: `garage` · `r2` · `s3` · `s3_compatible`; `state`: `ok` · `unavailable` · `read_only`.
- `GET /api/settings/history` → `{ retention_days: number | null, at_capacity: "evict" | "stop" }` (defaults: `null` = indefinitely, `evict`).
- `POST /api/settings/history/preview {retention_days}` → `{ retention_days, before, hours, lines, bytes, destinations: [{ id, name, hours, bytes }] }`: what that window would delete now.
- Owner only:
  - `POST /api/storage/destinations {name, kind, endpoint?, region?, bucket, prefix?, path_style?, access_key_id, secret_access_key, activate?}` → `201 { destination, verify }`. Saved even when Verify fails; made active only when `activate` and Verify passed. 409 `name_taken`.
  - `PATCH /api/storage/destinations/:id {…same fields, all optional}` (a blank secret keeps the saved one) → `{ destination, verify }`
  - `POST /api/storage/destinations/:id/verify` → `{ ok, cleanup, steps: [{ step: write|read|list|delete, ok, error? }], at }`
  - `POST /api/storage/destinations/:id/activate {copy_history?}` → the destination; 409 `verify_failed` · `removing`. `copy_history: true` starts a `copy` job from the previously active destination (both stay searchable until it finishes).
  - `DELETE /api/storage/destinations/:id {delete_history?}` → 204, keeping the objects in the bucket; with `delete_history: true` → `202 { job }`: a `delete` job deletes its hours, then forgets it (asking again returns the running job). 409 `active` for the active one (make another active, or turn history off first).
  - `PUT /api/storage/destinations/:id/capacity {capacity_bytes: number | null}` → the destination (at least 1 MB; `null` clears it). Without one, `garage-local` uses its Garage bucket quota.
  - `POST /api/storage/destinations/:id/retry-cleanup` → the destination: try refused deletes again now.
  - `PUT /api/settings/history {retention_days, at_capacity?, confirm?}` → the policy. 400 `invalid` outside 1–36 500 days. When the new window deletes archived hours and `confirm` isn't `true`: `409 { error, code: "confirm_required", preview }`.
  - `POST /api/storage/history/backfill` → `202` the `backfill` job (409 `no_destination` · `nothing_to_backfill`; asking again returns the running job).
  - `POST /api/storage/history/off` → 204: no destination receives new hours; what is archived stays.
  - `POST /api/storage/jobs/:id/cancel` · `POST /api/storage/jobs/:id/retry` → the job (409 `finished`). Cancelling a delete keeps what is left, read only.

## Source groups

- `GET /api/source-groups` · `POST /api/source-groups` (owner) · `PATCH|DELETE /api/source-groups/:id` (owner) · `PUT /api/source-groups/assign` (owner; move sources into a group, or back to automatic)

## Muted lines

- `POST /api/mute/rules` (owner) → the added rule · `PATCH /api/mute/rules/:id` (owner) · `DELETE /api/mute/rules/:id` (owner) → the deleted rule, for Undo
- `PUT /api/mute/sources/:name/global/:id {apply}` (owner): "Don't apply here" for a global rule on one source
- `PUT /api/mute/search {include: bool | null}` (owner): whether search includes muted lines
- `GET /api/mute/stats`: 24h hits per rule and source (a bounded scan, marked `estimated` when scaled up; cached for a minute)
- `POST /api/mute/preview`: what a draft rule would hide

Matching happens in the browser for the stream and search; these counts come from the stored window.

## Ingest tokens

- `GET /api/ingest-tokens` → `{ tokens: [{ id, name, preview: "qi_••••1a77", source | null, created, last_used, revoked }] }` (anyone signed in; previews only)
- `POST /api/ingest-tokens {"name","source"?}` → `201 { token, secret }` (owner; the secret only here)
- `DELETE /api/ingest-tokens/:id` → the revoked token (owner) · `POST /api/ingest-tokens/:id/restore` → the token, working again (Undo within 60 s, else 409)

## Accounts

- Public (no session): `GET /api/auth/state` → `{ auth: "on"|"off", setup_required, user, csrf, version, host, instance_name }` · `POST /api/auth/setup {name,email,password}` (first run only, else 409) · `POST /api/auth/login {email,password,remember?}` (401 / 429 + `Retry-After`) · `POST /api/auth/invite {token}` → the invite, or 410 `{ code: expired|used|revoked, invite }` · `POST /api/auth/invite/accept {token,name,email?,password}` · `POST /api/auth/reset {token}` → `{ email, name, expires }` · `POST /api/auth/reset/accept {token,password}` → 204 (signs out everywhere). Sign-in routes answer `{ user, csrf }` and set the cookie.
- Session: `POST /api/auth/logout` · `GET`/`PATCH /api/account {name,email,password?}` (changing the email needs the password) · `POST /api/account/password {current,password}` → `{ user }` (other sessions stay signed in) · `GET /api/account/sessions` · `DELETE /api/account/sessions/:id` · `POST /api/account/sessions/sign-out-others` · `GET /api/members` → `{ members, invites }` (invites for owners only).
- What's new (session): `GET /api/whats-new` → `{ release, eligible, since, seen, banner_dismissed }` · `PUT /api/whats-new {seen?, banner_dismissed?}` → the same. Seen item ids are kept per account and release (the list only grows); `eligible` is true for accounts created before this instance first ran the release, so a fresh install shows no markers.
- Owner: `POST /api/invites {email?,role}` → `201 { invite, token, path }` · `DELETE /api/invites/:id` · `PATCH /api/members/:id {role}` · `DELETE /api/members/:id` · `POST /api/members/:id/reset-link` → `{ token, path, expires }`. Removing or demoting the last owner: 409 `last_owner`.

## Ingest

Each needs `Authorization: Bearer qi_…` (see [Ingest](ingest.md)): `POST /ingest/ndjson`, `POST /ingest/vector`, `POST /ingest/fluentbit` (or `/ingest/fluent-bit`), `POST /v1/logs`, `POST /v1/traces`.
