# How quiet works

One host, one binary: `stream → flow → card`.

## Architecture

```
receivers ──► pipeline ─────────────────────► store ──► hub ──► WebSocket ──► UI
(Docker,      normalize → redact → ids         (ring +   (per-source
 HTTP: NDJSON,                                  SQLite)   broadcast)
 Vector, Fluent Bit,                              │
 OTLP/HTTP; qi_ tokens)                           └──► /api/search · /api/export · /api/flow ──► UI
```

### Server (`server/src`, one crate)

- `cli.rs`: clap; `server` (default), `pipe`, `admin`, `agent` (stub), hidden `healthcheck` used by the image.
- `receiver/`: the `Receiver` trait. Pull receivers (`docker.rs`) run a loop; push receivers mount routes: `http.rs` (all HTTP ingest: auth, gzip, body cap, rate limit), `shippers.rs` (NDJSON / Vector / Fluent Bit bodies → lines, envelope unwrapping, source naming), `otlp.rs` (OTLP/HTTP protobuf + JSON → canonical JSON lines; prost messages declared by hand, no protoc).
- `pipeline.rs`: the only path a line takes: paused sources dropped → size cap → normalize → **redact** → ids assigned in order → `Store::append` → hub broadcast.
- `normalize.rs`: JSON parsing, timestamp, level, correlation ids, the row summary. `redact.rs`: [redaction before storage](#redaction-before-storage). `idpolicy.rs`: which id keys count and in what order.
- `store/`: the `Store` trait (`append`, live tail, `search`, `expire`, `enforce_cap`, `flush`, `restore`, `usage`), `MemoryStore` (bounded ring per source; tests and `--store memory`) and `SqliteStore` (hourly partitions, FTS5, id index, ring in front). `retention.rs`: the hourly drop job.
- `flow.rs`: stitching (a bounded walk over the id index) and shaping lines into step nodes + edges; `flow_api.rs`: `/api/flow`, `/api/flow-summaries`.
- `search.rs`: the query language and `SearchQuery`; `search_api.rs`: `/api/search`, `/api/export`, export tokens; `export.rs`: formats, PII masking, `qx_` tokens; `export_jobs.rs`: large exports prepared on the server.
- `stream_api.rs`: stream stats, fields per source, id coverage. `lint.rs`: Check my logs.
- `mute.rs`, `mute_api.rs`: muted-lines rules and their counts. `grouping.rs`, `source_groups_api.rs`: how sources group (Compose / Swarm / label / custom groups).
- `settings.rs`, `settings_api.rs`: everything owners change in the UI, kept in the `settings` table. `system.rs`: the system banners.
- `accounts.rs`: users, sessions, invites and reset links in `quiet.db` (argon2id; session ids and link tokens stored as SHA-256), no HTTP in it. `auth.rs`: the session gate in front of `/api`, cookies, CSRF/same-origin checks, sign-in backoff. `auth_api.rs`: `/api/auth/*`, `/api/account*`, `/api/members*`, `/api/invites*`. `admin.rs`: `quiet admin reset-password`.
- `tokens.rs`: `qi_` ingest tokens (SHA-256 only, `ingest_tokens` table, cached in memory, per-token rate bucket); `tokens_api.rs`: `/api/ingest-tokens`. `pipe.rs`: `quiet pipe`, stdin → `/ingest/ndjson`.
- `hub.rs`: source registry + per-source broadcast channel. `api.rs`: `/health`, `/ready`, `/api/*`, the stream WebSocket.
- `web.rs`: the built UI embedded with rust-embed (SPA fallback, ETags, immutable hashed assets, gzip/br).
- `server.rs`: wiring and graceful shutdown (SIGTERM → `/ready` 503 → drain → close streams with 1012 → stop receivers → timeout).
- `history/`: retained history: `catalog.rs` (destinations, archived hours, gaps, jobs, policy), `remote.rs` (object store client, object layout, Verify), `secret.rs` (secrets at rest), `garage.rs` (Garage bootstrap and quota), `jobs.rs` (the background worker: history retention, eviction, backfill, copy, delete); `history_api.rs`: `/api/storage/*`, `/api/settings/history*`. The retention job calls it before dropping hours.
- `bindings.rs`: ts-rs exports the wire types to `web/src/gen/`; a test fails when they are stale (`make types` regenerates).

### Web (`web/src`)

React 19 + Vite + TypeScript, Tailwind v4 and shadcn/ui on Base UI, TanStack Router, TanStack Query, TanStack Virtual, cmdk (⌘K), zod, lucide. Toasts are quiet's own small toaster (`components/ui/toaster.tsx`, `lib/toast.ts`). Biome lints and formats; Vitest + Testing Library test.

- Routes: `/` (stream), `/search`, `/flow/$id`, `/line/$lineId`, `/connect?kind=`, `/guide`, `/sources`, `/sources/$name`, `/settings` (General) and `/settings/account`, `/members`, `/ingest-tokens`, `/flow-id-order`, `/muted-lines`, `/storage`, `/appearance`, `/about`. Signed out: `/setup`, `/signin?redirect=`, `/invite/$token`, `/reset/$token`. The root route's `beforeLoad` sends signed-out visitors to sign in; search and path params are zod schemas.
- `routes/` are pages, `components/` small pieces (`components/ui/` is the shadcn kit, `components/mobile/` the phone layout below 768px), `lib/` hooks and helpers (`use-stream.ts` is the WebSocket with jittered backoff).

### Keys

Press `?` anywhere for the full sheet.

- **Stream:** `space` pause · `G` newest · `J`/`K` move · `↵` open flow · `D` diagram · `M` mute (`⇧M` menu) · `C` copy · `⌘Z` undo a mute · `/` filter · `E` errors only · `1`–`4` levels · `X` clear filters
- **Flow + card:** `J`/`K` steps · `tab` Fields / JSON / Raw · `C` copy · `F` filter by value · `O` open in stream · `esc` back
- **Anywhere:** `⌘K` palette · `⌘/` search · `S` sources · `T` theme · `⌘B` sidebar · `G H` guide · `⌘⇧C` copy agent prompt · `G L` Check my logs

## How a line is read

- JSON first; anything else is kept as raw text (level sniffed from `ERROR`/`WARN`/…). JSON sent as a string inside a field is shown as structure.
- Timestamp: `timestamp` / `time` / `ts` / `@timestamp` (ISO preferred, epoch s/ms/µs/ns ok), else Docker's timestamp, else arrival. Duplicate keys are tolerated and flagged.
- Level: pino numbers (10–60) or names (`level`, `lvl`, `severity`, `log.level`, `levelname`).
- Every correlation id on the line is indexed (up to 4 levels deep, so a job's `data.request_id` counts). The row shows one by priority `request_id → job_id → trace_id → correlation_id` (Settings → Flow id order changes it).
- The stream row reads the canonical completion event: `flow · METHOD path → status_code`, plus why it failed (`error.reason`), what it created, `slow`, or the attempt. Lines over the size cap (Settings → General) are cut and flagged; plain text can be dropped there too.
- Records in the v0.1.0 format (`msg`, `outcome`, `wideEvents.calls`, `status`) still read everywhere.

The logging contract quiet reads best is in [logging-guide.md](../logging-guide.md).

## Redaction before storage

Every line is sanitized in the pipeline after it is parsed and before it is stored, indexed or broadcast. Raw retention, fields, search, the live stream, Copy, Raw and exports all see the same `[REDACTED]` data. There is no reveal switch: what is redacted was never stored. Lines already stored are not rewritten.

- **Always redacted:** values under credential keys (`password`, `passwd`, `secret`, `token`, `access_token`, `refresh_token`, `api_key`, `authorization`, `cookie`, `set-cookie`, `card_number`, `cvv`, `private_key`, and any key ending `_password`, `_secret`, `_token`, `_api_key`, `_private_key`), matched on the last key segment, any case, `-` read as `_`.
- **By shape, whatever the key:** `Bearer …` / `Basic …` credentials, JWTs and PEM private keys, also inside free text, and `key=value` / `"key": "value"` pairs whose key is a credential.
- **Per source** (Sources → a source → Settings): extra keys, as a last segment (`iban`) or a dotted path (`customer.address`), and personal-data groups to hide. Email and phone stay visible unless a source hides them.
- A redacted line carries a `redacted:N` flag. Values that are already masked (`[REDACTED]`, `***`) are left alone.

Exports additionally mask personal data (email, phone, names, IPs, user agents) by default; members always export masked. See [Export](#export).

## Flows

A flow is every line that shares a correlation id (`request_id`, `job_id`, `trace_id`, `correlation_id`, any spelling the normalizer knows), stitched across ids:

- Opening an id finds every line carrying it (the id index, all sources, the retention window), then follows the *other* ids on those lines. A worker line with `job_id` + `request_id` joins the request to its job, and the job's attempts (which may carry only `job_id`) come along. Pass `request_id` into your job data and log it on the worker.
- The walk is bounded: 2 hops past the opened id, 64 ids, 1000 lines. Hitting a limit marks the flow "cut at the flow size limit" instead of failing, so a hot id (a constant `trace_id`) can't pull in the whole window.
- **Activity list (default view).** One row per request (`201 · Created`) and per logical job, grouped by source, queue and the queue's own `job_id`. A job's attempts sit inside it, with execution time, queue wait and total labelled. Job states come only from the events: Completed, Completed after retry, Failed · N attempts, Retry scheduled, or Completion not observed. Child jobs appear only with an explicit parent link (`parent_job_id`). Opened by a job id, the job comes first and its request sits under *Related request*. The field card of the selected event sits beside the list (resizable); **Full screen** covers the app.
- **Timing** shows the timeline and graph: each line is a step node ordered by when its work started (`time − duration_ms`, since a canonical event is written when the work ends). Edges: `next` within a source, `retry` between attempts of one job (the gap is the backoff), `handoff` across sources labelled with the shared id. v0.1.0 `wideEvents.calls` / `wideEvents.steps` still become child steps.
- A step is an error at level ≥ error or status ≥ 500 (or a v0.1.0 `outcome: failed`); a warning at level warn or 4xx.
- A line with one id and nothing else sharing it opens as a one-event flow: its field card beside an "only one event observed" note. A line with no ids opens the same way (`/line/<id>`). An unknown id shows "No events with this ID" with close matches when there are any.

Traces: lines with OTLP span ids (spans sent to `/v1/traces`, or any line with `span_id` + `parent_span_id`) form a span tree inside their flow (they stitch by `trace_id`). Each span sits under its parent span, and log records carrying a `span_id` sit under that span. Span events become child steps.

Diagram: the field card's Diagram tab draws the event as cards (one per object / array) with edges from parent rows, on a pan/zoom canvas; it opens at 100%, `Esc` shrinks it back, Full screen hides the sidebar. `?card=diagram` on a flow URL opens it (Stream preview → **Diagram**, `D`). Past depth 3 starts collapsed, arrays show 5 items, ~200 keys / 32 KB = large event (notice, minimap, Expand all). Its settings live in this browser; Export image draws a PNG client-side.

URLs: `/flow/<id>?line=<line id>` (the event whose card is open) and `/line/<line id>`. Search's **Group by flow** uses `/api/flow-summaries`, so a request and its job's attempts land in one group.

## Search

The box takes free text and filters, the same string the URL and the export curl carry:

```
dealer 88 level:>=warn source:order-worker status:>=500 -path:/health "exact phrase" -noise
```

- words and `"phrases"` match the whole raw line (FTS5; every word is a prefix, so `dealer` finds `dealers`); `-word` excludes
- `level:warn` (or `>=warn`): minimum level; `level:info,warn`: exactly those levels
- `source:name` (repeatable)
- `id:…`, `request_id:…`, `job_id:…`, `trace_id:…`, `correlation_id:…`: any line carrying that id (indexed)
- any other `key:value`: that field equals the value (`error.code:TIMEOUT` walks dots); `status:>=400` compares numbers; `path:/api/v1/orders*` matches a prefix; `-key:value` excludes
- click any value in a result to add it as a filter

Results group by flow (or show events), with a histogram, a time range (presets or typed, like `today 08:07` → `now`) and Show muted.

## Storage

SQLite (bundled, WAL) in `--data-dir`. One set of tables per hour: the lines (only the raw line is stored; fields and ids are re-derived when read), a contentless FTS5 index over the raw line, and a side index of every correlation id. A writer thread coalesces queued lines into one transaction; the in-memory ring in front serves the live stream and is warmed from disk on start, so ids, sources and the backlog survive restarts. Every minute (and right after a storage setting changes) the retention job drops hours older than the window, then deletes lines of sources with a shorter window of their own, then drops the oldest hours while the database is over the disk cap, and hands the pages back to the OS (incremental vacuum). Per-source volume is counted per hour (`source_hours`), so Settings → Storage never scans lines.

### Retained history (v0.1.1)

Optional, off until a destination is connected (design: [docs/v0.1.1-storage-design.md](../v0.1.1-storage-design.md)). The local window above is unchanged and works on its own; retained history keeps hours after they leave it, in **Garage** running next to quiet (`make up-history`, see [Configuration](configuration.md#retained-history-garage)) or a bucket the owner brings: **Cloudflare R2**, **Amazon S3** or any **S3-compatible** store (MinIO, Backblaze B2, Wasabi, Ceph).

- **Archive before drop.** Before the retention job drops an hour that left the window, it builds a **segment**: a standalone SQLite file with that hour's three tables (lines, FTS, id index; the same layout, so history is read with the same SQL) and a `segment` metadata table, compressed with zstd. Lines of sources switched off under *Keep in retained history* are left out. It uploads `<prefix>v1/hours/YYYY/MM/DD/<hour>.seg.zst` and `<prefix>v1/manifest/<hour>.json` (counts, sources, time range, sha256), checks the object's size with HEAD, records the hour in the catalog and only then drops it locally. `<prefix>` defaults to `quiet/<instance id>/`, so two servers can share a bucket; `<prefix>v1/instance.json` describes the instance.
- **Already sanitized.** Segments are built from stored lines, after redaction before storage: nothing reaches object storage that redaction removed.
- **When the destination is unreachable** the hours wait on local disk (the window doesn't drop them), a system banner says how many and when quiet retries (30 s, doubling to 15 min). Only the disk cap can drop a waiting hour, and that becomes a gap.
- **Gaps** record hours that left local storage without being archived, once history has been turned on: `no_destination`, `destination_unavailable` (waited, then the cap dropped it), `disk_cap` (dropped before it left the window), `excluded` (only excluded sources) or `at_capacity` (the destination was full and the policy said stop). Search will say "not retained" for them.
- **Keep history for** 30 days, 90 days, 1 year, a custom number of days, or indefinitely (the default: nothing is deleted until an owner picks a window). It applies to every destination. A shorter window first shows what it deletes ("deletes 214 hours · 38 GB from production-r2 and garage-local") and needs confirming; the background worker then deletes those hours (segment, manifest, catalog row) and keeps deleting hours as they age out.
- **Capacity.** A destination can have one: set by an owner, or the Garage bucket quota for `garage-local` (read from Garage's admin API every few minutes). At capacity, the policy says **evict oldest** (the default: the oldest hours there are deleted until it fits, never its newest hour) or **stop archiving** (hours wait on local disk with a `history_at_capacity` banner; only the disk cap drops them, as `at_capacity` gaps).
- **Cleanup blocked.** A delete the destination refuses (AccessDenied, object lock) marks those hours `cleanup_blocked`, raises a `history_cleanup_blocked` banner and backs off (5 min, doubling to 6 h; other failures from 30 s). Retry tries at once. Nothing is retried in a tight loop.
- **Backfill.** Right after history is turned on, quiet offers to archive the complete hours still in the local window now, so history has no hole if the window is shortened later. When those hours expire, an unchanged hour isn't uploaded again.
- **Switching destinations** can copy the old one's history to the new one (server-side when both are the same bucket and credentials, else download → upload); both stay searchable until the copy finishes. **Removing** a destination keeps its objects in the bucket, or deletes them first and then forgets it. The active destination can't be removed until another is active or history is turned off.
- **Jobs** (backfill, copy, delete) are kept in `quiet.db`. What a job still has to move is re-derived from the catalog on every step, and a catalog row is written only after the object is checked, so a job resumes after a restart. They show in Settings → Storage → Retained history with progress, Cancel and Retry.
- **Destinations.** Several can be saved; one is **active** (new hours go there), the others are **read only** and keep what they hold. A destination must pass **Verify** (write → read → list → delete, each step reported) to be made active; a failed delete only means cleanup will be blocked. Secrets are encrypted at rest with ChaCha20-Poly1305 and a key in `<data dir>/secret.key` (0600), and are never returned: the API shows `AKIA••••7Q2X`. Removing a destination forgets it and its catalog rows; its objects stay in the bucket.
- **Catalog** (in `quiet.db`): `instance` (instance id, when history was first on, the history policy), `destinations`, `history_hours`, `history_gaps`, `history_jobs`. Search plans from it and never lists a bucket.
- Still to come (Phase 5c): searching retained history.

## Settings

Owners change these in the UI; members see them read-only. Writes need a session and the CSRF header, like every `/api` write. Everything is stored in the `settings` table of `quiet.db` (kept on disk even with `--store memory`) and applies at once, without a restart.

**Precedence (storage):** a value saved in Settings → Storage → the `--retention` / `--max-disk` flag or `QUIET_RETENTION` / `QUIET_MAX_DISK` → the built-in default (24h, 5GB). The page shows where each value comes from (*set here*, *from flag*, *default*); "use flag" deletes the saved value so the flag applies again. If a flag seems ignored, check Settings → Storage.

**Precedence (source grouping):** the opposite of storage. `QUIET_GROUP_BY` / `QUIET_GROUP_LABEL` → a value saved in Settings → General → Source grouping → `auto`. With either variable set, the control is read-only and says so.

**Precedence (muted lines in search):** a source's own choice → Settings → General → `QUIET_SEARCH_INCLUDE_MUTED` → off.

**Custom source groups:** owners can make their own groups on **Sources** (New group, a source's ⋯ → Move to group, a group header's ⋯ → Rename / Move up / Move down / Delete). A group you assign wins over automatic grouping, sits above the automatic groups, and survives mode Off (the list goes flat; the groups come back). Deleting a group puts its sources back to automatic grouping and deletes no lines. `QUIET_GROUP_BY` locks only the mode.

| Page | What |
|---|---|
| General | Instance name (browser tab, user menu, invite links, also shown signed out); timezone for every timestamp (`local` = each viewer's browser, `UTC`, or an IANA zone); timestamp format; source grouping (Auto / Custom label / Off); whether search includes muted lines; line size cap and whether non-JSON lines are kept. |
| Account | Profile, password (other sessions stay signed in), sessions with "Sign out everywhere else". |
| Members | Members and roles, invite links, password reset links (owners). |
| Ingest tokens | `qi_` tokens: create, bind to a source, revoke (Undo within 60 s). |
| Flow id order | Which correlation-id keys count (`request_id`, `job_id`, `trace_id`, `correlation_id`, plus up to 8 custom keys) and in what order (the first found is shown on the row), with coverage per key; **match ids by value** (default: an id links lines whatever key carries it) or **by key** (only the same key links, so a numeric `job_id` 42 and a `request_id` 42 never merge). |
| Muted lines | Global rules (hide matching lines on every source), which setting wins for search, hits per rule. |
| Storage | Disk used vs the cap, hourly partitions, volume and rate per source, the projected time to the cap; searchable window (1h / 24h / 3d / 7d); disk cap; **Purge now** (owner, type `purge` to confirm) deletes every stored line. |
| Appearance | Saved to this browser: theme (Dark / Light / System), stream direction, row density (32 / 28 / 24 px), wrap long lines, tint error rows, accent colour. |
| About | Version, commit, build, store, database size, Docker, the public URL (used in printed links), update check. |
| Sources → a source → Settings | Display name; matched by; correlation id order with coverage; the level filter the stream opens with; a shorter window than the instance's; redaction (extra keys, hide email / phone) and export masking; **muted lines** (route, method + route, exact message or field rules: hidden from stream and search until "Show muted", still stored and searchable); ignore the source (pause ingest and hide it); purge its lines. The **Rejected** tab lists refused ingest requests (status, reason, token, grouped per minute; bodies are never kept). |

Changing which id keys count applies to new lines, to every line read from now on (stored lines are re-read with the current rule) and to stitching; the id index of lines stored before still holds the old keys, and stitching ignores those.

## System banners

From `GET /api/system`: Docker unreachable (with troubleshooting steps), disk near (≥ 90%) or at the cap (the cap dropped hours in the last hour), the data volume itself almost full (< 500MB or < 5% free), lines failing to save (e.g. `database or disk is full`), and refused ingest requests in the last 15 minutes. Each can be dismissed for the tab.

## Export

From the stream (top bar), a search (Export) or a flow (Export flow): NDJSON (the raw lines; plain-text lines are wrapped as `{"time","source","level","message"}` so every row is JSON), a JSON array of parsed lines, or CSV with chosen columns (dot paths work; nested values stay JSON, missing fields stay empty). Options: gzip, **mask PII** (on by default: `email`, `phone`, `*_name`, `ip`/`ip_address`/`client_ip`/`x-forwarded-for`, `user_agent` keys, plus emails and IPv4 addresses inside any text; a source can switch groups off or add keys), include the raw line. Exports contain stored, already-redacted data. **Download** streams the file (very large exports are prepared on the server first); **Copy curl** copies a command with a `qx_` token (read-only, this query only, reusable for 15 min). Ingest tokens stay send-only.
