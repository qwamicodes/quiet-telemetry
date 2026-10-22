# Decisions

Technical choices made while building quiet, newest slice first. Each one
stands unless Kwaame pushes back. The product-level log lives with the
project notes; this file records what the code does and why.

## v0.1 design parity (2026-10-22, PR #11)

Choices made while matching the v0.1 boards (`docs/v01-parity.md` has the
per-board status). Source grouping has its own section further down.

- **Large exports are prepared in the browser, not on the server** (05.7).
  Over ~100k lines the dialog fetches `/api/export` as a stream, counts lines
  and bytes for the progress bar and "~Ns left", and keeps going when the
  dialog is closed; an "Export ready" toast offers the file (05.8). No
  server-side job queue: export already streams page by page (slice 2), and a
  job would mean storing a temp file inside the 256MB container. Cost: lines
  that expire during a long export are not promised, and closing the tab
  cancels it.
- **Stream histogram = the last hour in one-minute bars, stacked by level**
  (`/api/stream/stats`). The board shows ~96 bars over a longer span; an hour
  matches what the live stream is about and keeps the stats query cheap.
- **Remove source = pause ingest + hide + purge its lines.** There is no source
  table to delete from; a Docker container that logs again comes back. An
  ingest token is separate and stays valid until it is revoked (the remove
  dialog links to Ingest tokens instead of revoking for you).
- **"Stopped sending" banner** (06.1): a source that had lines earlier in the
  hour and none in the last three one-minute buckets, so it shows after about
  2–3 minutes of silence.
- **Similar values** (05.3) are computed in the browser: on zero results the
  page runs a wider search for stems of the query words (`payout_reversed` →
  `payout`, `rever`) and offers the `key:value` pairs it finds. No server
  endpoint yet.
- **Timezone** (07.10) is a searchable input over the browser's IANA zone list
  (`Intl.supportedValuesOf`) plus `local`, not a plain select: the list has
  400+ entries. A zone the browser doesn't know can't be saved.
- **Grouping: env wins and locks the UI**; **auto order is `quiet.group` →
  Compose project → Swarm stack** (details in *Source grouping*).
- **Custom flow id keys** (07.8) are stored in the existing `key` column of the
  id index: 0–3 for the built-ins, the field name as text for a custom key
  (SQLite keeps a non-numeric string in an INTEGER column). No migration. At
  most 8 custom keys; a key matches an exact top-level field first, then the
  dotted path, at its place in the order.
- **Check my logs** (Guide 11.x) is a heuristic scorecard over the newest lines
  of one source (`GET /api/sources/:name/lint`, sample 1000): JSON, timestamp,
  level, service, msg, canonical line, request_id, job_id, job ↔ request_id,
  error object, outbound calls, PII. Each check passes or warns by share of
  lines at per-check thresholds (e.g. JSON pass ≥ 95 %, warn ≥ 50 %), is `na`
  when nothing applies, and carries a one-line fix. PII is pattern matching
  (email / phone shapes in values), so it can miss or over-flag.
- **Undo on token revoke** (08.3): revoke takes effect at once; for 60 s
  (`UNDO_REVOKE_MS`) an owner can `POST /api/ingest-tokens/:id/restore` and the
  same secret works again. After that it is 409 and the token stays revoked.
  The toast offers Undo for 15 s.

**Open questions**
- Should removing a source really delete it (and offer to revoke its bound
  token in one step) rather than pause + hide + purge?
- Should similar values move to a server endpoint (one pass over the window
  instead of a second search from the browser)?

## Slice 6 · Settings, storage, per-source settings, system states (2026-10-22)

Scope agreed beforehand: retention / disk cap / purge in the UI over the slice 2
job, live storage usage, per-source settings, General, failure states with
`/api/system`, and a memory review against the 256MB prod limit.

**Persistence and precedence**
- One `settings (k, v JSON, updated, by)` table in `quiet.db`: keys `general`,
  `storage`, `flow_ids`, `source:<name>`. Read into memory at start; a write
  goes to SQLite first, then memory. A value this version can't read is logged
  and skipped, never fatal. Always on disk (even with `--store memory`), like
  accounts.
- Storage precedence: **UI value > `--retention`/`--max-disk` (or env) >
  built-in default.** The UI wins because it is the only place an owner can
  change it without a redeploy, and the page shows the origin of each value
  (*set here / from flag / default*) with "use flag" to delete the saved one.
  Cost: a changed flag looks ignored while a UI value exists; documented in the
  README and the prod compose comments.
- Window choices in the UI are 1h / 24h / 3d / 7d (page 11 boards, decisions
  d-Retention); the API takes any whole hour between 1h and 7d. The cap must be
  ≥ 10 MB. "At the cap" has one behaviour (drop the oldest hour) and is shown
  read-only.
- The retention job reads the settings on every pass and is woken by a change
  (`Notify::notify_one`, so a change during a sweep isn't lost); a shorter
  window or lower cap applies within a second instead of a minute. Search and
  flows read the live window too (`AppState::retention_ms()`).

**Per-source settings**
- Display name (stored lines keep the real name), hidden (left out of the
  sidebar only; still stored, searchable, listed under Sources), pause ingest
  (the pipeline drops the source's lines before parsing and counts them; Docker
  lines dropped while paused are not backfilled), a window ≤ the instance's
  (enforced on save; if the instance window later drops below it, the instance
  window wins), id keys + order, default level filter, export masking.
- Per-source windows delete line by line inside the hourly tables (lines, the
  contentless FTS5 rows via the `'delete'` command with the original text, the
  id index, counters); an hour left empty is dropped whole. Volume per source is
  counted per hour in a new `source_hours` table, written with the lines and
  backfilled once for databases from earlier slices, so Storage never scans lines.
- The stream opens with the source's default level unless the URL has a level;
  `level=all` overrides a default.

**Correlation ids: which keys count, order, match by key**
- Slice 4 showed the id order read-only. Now: Settings → Flow id order (instance)
  and a per-source override choose which of the four keys count and in what
  order. A key left out is not a correlation id for that source: not shown on
  the row, not indexed for new lines, not followed when stitching.
- It is applied inside `normalize` through a process-wide policy (`idpolicy.rs`)
  because stored lines are re-derived with `normalize` on every read; threading
  a handle through every read path (ring, SQLite rows, export, flows) would touch
  all of them for the same result. The server's `Settings` installs it; tests and
  `Settings::memory()` never do. Old index rows for a key that no longer counts
  are ignored by stitching (a line joins only if its re-derived ids carry the id).
- Answers the slice 3 open question (ids matched by value): new **match ids by**
  setting, `value` (default, unchanged behaviour: `data.request_id` on a job
  links it to the request) or `key` (only the same key links; a numeric
  `job_id` 42 never merges with `request_id` 42). An id typed in (`/flow/42`)
  matches any key at the start. Kept `value` as default: Kwaame's worker lines
  carry the request id under `data.request_id`, which is a different spelling
  but the same canonical key, so `key` would also work for them; flip it if
  numeric ids collide.
- Custom id fields (07.8's "Add a field, e.g. x-request-id") are not built: the
  index stores one of four canonical keys. Open question.

**Masking**
- Per source: built-in groups (email, phone, name, ip, user_agent) can be
  switched off and extra keys added (a bare key matches at any depth, a dotted
  path matches exactly). Applied server-side in exports (members always masked,
  owners when `mask=pii`). The stream, flows and field card still show values
  unmasked to signed-in users; server-side masking of every line response for
  members is not in this slice (open question).

**Purge**
- `POST /api/storage/purge` (owner, CSRF): everything (`confirm: "purge"`, drops
  every hour including the newest, clears the ring) or one source
  (`confirm: <name>`). The writer is flushed first so a line from a moment ago
  goes too. Logged at warn with who did it.

**System states**
- `GET /api/system` (any signed-in user) → issues: Docker unavailable (error
  text from the socket discovery merged from main), disk near cap (≥ 90%), at
  cap (the cap dropped hours within the last hour, or ≥ 100%), data volume low
  (`statvfs`: < 500MB or < 5% free; `libc` added), store write errors (the
  SQLite writer and refused appends; `database or disk is full` is recognised),
  ingest requests refused in the last 15 min.
- Refused ingest requests are recorded in memory, grouped per minute by
  endpoint/status/reason/source/token preview, kept 24h (≤ 2000 groups);
  bodies and remote addresses are not kept (the receiver has no peer address
  without extra plumbing). The source is known when the request named it
  (`X-Quiet-Source`); token-bound sources can't be attributed on a 401 because
  the token didn't resolve. Restart forgets them.
- UI: one banner per issue across the top of the app, dismissible per tab
  (sessionStorage) until the issue clears; Docker has troubleshooting steps.

**Memory (256MB prod limit)**
- Slice 2's ring was 10k lines per source with no byte bound. A parsed line
  costs roughly raw + 3× raw (serde_json map) + summary + ids; at ~800 B lines
  that is ~3–4 KB, so 10k lines ≈ 35 MB per source and 6–8 sources would pass
  256 MB on the ring alone.
- Now: `--ring-memory` / `QUIET_RING_MEMORY`, default **64MB** (estimated) for
  every ring together, split evenly between sources; a ring over its share drops
  its oldest live lines (stored lines are untouched; the stream backlog just
  starts later for chatty sources). `QUIET_RING` (lines per source) stays as a
  second bound. That leaves room for SQLite caches (~2 MB × 5 connections), the
  broadcast fan-out (Arcs), search/flow/export pages and the runtime. The
  estimate is a heuristic (`line_cost`), not measured allocation.

**UI**
- Settings nav (v0.1 boards): General · Account · Members · Ingest tokens ·
  Flow id order · Storage · Appearance. General is per 07.10 minus public URL,
  timestamp format, max line size and keep-non-JSON (not in scope); theme moved
  to Appearance. About (07.6) is not built; the version shows in Appearance.
- `/sources/$name?tab=` (06.2 / 06.5 / 06.6, modest): Overview (stats,
  connection), Rejected, Settings. No fields-detected table, histogram or
  malformed-lines tab yet.
- Timezone: `fmtTime`/`fmtClock` take the instance zone (Intl, cached
  formatters); `local` keeps the browser's.
- Stream direction: instance default from General, per-browser flip stored in
  localStorage; `j`/`k` follow the visual order.
- Instance name: tab title (`legivent · quiet`), user menu header, invite page
  "Join legivent"; exposed signed out via `/api/auth/state` (it's shown on the
  invite page anyway).

## Slice 5 · Accounts, auth, members (2026-10-22)

Scope agreed beforehand: local email + password accounts, first-run owner
setup, roles owner/member, copy-link invites (SMTP invites are v0.2), owner
reset links + a CLI for locked-out owners, every `/api` route behind a
session, `qi_`/`qx_` tokens keep working without one.

**Storage**
- Four tables in `quiet.db`: `users`, `sessions`, `invites`, `password_resets`.
  Accounts are always on disk under `--data-dir`, even with `--store memory`:
  forgetting them on restart would hand owner setup to whoever arrives first.
- Passwords: argon2id with the `argon2` crate's defaults (19 MiB, t=2, p=1,
  OWASP's recommendation), PHC strings, random 16-byte salt. Unknown emails
  are verified against a dummy hash so they cost the same as a wrong password.
  `argon2`/`blake2` are compiled with opt-level 3 in dev builds (tests and
  `make dev` would otherwise take seconds per hash).
- Session ids, invite and reset tokens: 32 random bytes, hex; only SHA-256 is
  stored. Prefixes `inv_` / `rst_` for links (the design's `inv_` kept);
  session cookies have none.
- Minimum password length 12 (as on the design boards), max 256.

**Sessions**
- Cookie `quiet_session`: HttpOnly, SameSite=Lax, Path=/, `Secure` when
  `X-Forwarded-Proto: https` (`QUIET_COOKIE_SECURE=auto`, default; `on`/`off`
  force it). quiet itself never terminates TLS, so the proxy header is the
  only signal; trusting it is safe because a spoofed `https` only makes the
  attacker's own cookie stricter.
- "Keep me signed in" (default on): 30 days absolute. Off: browser-session
  cookie, forgotten server-side after 12 hours. No sliding expiry; `last_seen`
  is written at most once a minute (the sessions list and members list show it).
- Open WebSocket streams re-check their session every 30 s and close with code
  4401 when it ended; the UI then shows "session expired" instead of reconnecting
  forever with a stale cookie.

**CSRF**
- Two layers. (1) Same-origin: unsafe methods and WebSocket upgrades must carry
  an `Origin` (or `Referer`) whose host matches `Host` or `X-Forwarded-Host`;
  `Origin: null` and `Sec-Fetch-Site: cross-site` are refused. Requests with
  neither header (curl, scripts) pass layer 1. (2) Cookie-authenticated unsafe
  requests must send the session's CSRF token in `X-Quiet-Csrf` (random per
  session, handed out by `/api/auth/state` and every sign-in response,
  compared in constant time).
- The public auth routes (setup, login, invite/reset accept) get layer 1 only,
  which stops login CSRF.
- No CORS is configured, so a cross-site page can't send the custom header at
  all; layer 2 holds even if a proxy rewrites `Host` oddly.

**Login backoff**
- In memory, per `email:` and per `ip:` key. 5 free failures per email, 20 per
  address inside a 15 min window, then 1 s, 2 s, 4 s … capped at 15 min
  (429 + `Retry-After`). A success clears the email key only. Unknown invite and
  reset tokens count against the address too.
- Client address: the socket peer, or with `QUIET_TRUST_PROXY=on` the rightmost
  `X-Forwarded-For` hop (what the trusted proxy itself saw) / `X-Real-IP`.
  Off by default because a spoofable header must not decide lockouts.
- Not persisted: a restart forgives failures. Accepted for v0.1.

**Gating**
- Router split: `/health` and `/ready` open; public auth routes behind the
  origin check; everything else behind `auth::gate` (a `route_layer`, so it
  runs before extractors; an unauthenticated WebSocket upgrade is a 401, not a
  half-open socket).
- `GET /api/export` with an `Authorization` header skips the session; the
  handler already rejects anything but a valid `qx_` token for that exact
  query. Any other route ignores bearer tokens.
- Ingest endpoints belong to the receivers and were never under `/api`; they
  keep using `qi_` tokens (`QUIET_INGEST_AUTH`). Unchanged.
- `/api/health` now needs a session (it lists receivers, disk use and token
  counts). The signed-out pages read version (and, during first run only, host
  checks) from `/api/auth/state` instead.

**Members' rights** (owner decides everything; members read)
- Member: reads every source, the stream, search, flows; exports with PII
  always masked (server-side; a member's `qx_` token is only issued for a
  `mask=pii` query, else 403 `mask_required`); sees the members list (no
  invites) and the ingest token list (previews only); manages only their own
  name, email, password and sessions.
- Owner only: create/revoke ingest tokens, create/revoke invites, change roles,
  remove members, make reset links. Several owners are allowed (the design's
  "1 per instance" became "at least 1"); the last owner can't be demoted or
  removed, and an owner can't remove themselves (ask another owner).
- Every role change, removal, invite, reset link and token change is logged
  with who did it (`tracing` info lines; no secrets).

**Passwords and recovery**
- Changing your password needs the current one and signs out every *other*
  session (the board said other sessions stay; signing them out is what makes
  a password change useful after a leak, and the copy now says so).
- Changing your sign-in email needs the current password.
- Owner reset link: `POST /api/members/:id/reset-link`, one use, 24 h, a newer
  link voids older ones; using it sets the password and signs that user out
  everywhere. No email.
- Locked-out owner: `quiet admin reset-password <email> [--data-dir] [--url]`
  prints a one-time link valid for 1 hour. It writes to the same `quiet.db`
  (SQLite WAL), so it works while the server runs. The design's
  `quiet user reset-password` printing a one-time *password* became a link:
  same flow as owner resets, no password in terminal scrollback, nothing to
  force-change at next sign-in.

**`QUIET_AUTH=off`**
- Kept, for local development only: every request is a synthetic local owner,
  no cookie, no CSRF. The server refuses to start with `off` unless `--addr` is
  a loopback address. Default `on` everywhere, including `make dev` and both
  compose files (setup takes ten seconds once per data dir).

**Listening address**
- With sign-in on, binding `0.0.0.0` is safe; the README, compose files and
  connect panel no longer say "loopback until accounts". The binary's default
  stays `127.0.0.1:7070` (the image uses `0.0.0.0`). TLS stays the proxy's job.
- Every response carries `X-Frame-Options: DENY`, `X-Content-Type-Options:
  nosniff` and `Referrer-Policy: same-origin` (invite/reset tokens are in the
  path and must not leak through a Referer).

**UI**
- Routes `/setup`, `/signin?redirect=`, `/invite/$token`, `/reset/$token`
  render without the app shell. The root route's `beforeLoad` reads
  `/api/auth/state` (cached in React Query, updated by the mutations, never
  polled) and redirects: no users → setup, no session → sign in with
  `redirect` = where you were (only same-origin paths are accepted).
- A 401 `session_expired`/`session_required` from any call (or stream close
  4401) opens the "session expired" dialog over the current page (board 01.5);
  signing in again keeps the page and refetches.
- Invite page locks the email when the invite names one; expired/used/revoked
  invites show the board 01.4 card with who created it and when. Path params
  are zod schemas: a malformed link renders "This link is broken" without a
  request.
- Members (07.2): an invite link is shown once (only its hash is kept), so the
  design's "Copy invite link" on a pending row became "New link" (creates a
  fresh link with the same email/role and revokes the old). Rows: role select
  and a ⋯ menu (reset link, remove) for owners; read-only for members.
- Account (07.1): profile, password (meter), sessions with sign out / sign out
  everywhere else.
- New `components/ui/dropdown-menu.tsx` on Base UI Menu with no GroupLabel
  export (the legivent #162 crash); a jsdom test opens it.

## Source grouping (2026-10-22, PR #11)

Asked by Kwaame (modelled on a container manager's Containers view), then made
configurable because it ships as an update. Boards v0.1-06.7, 06.8, 03.8,
03.9, 07.11.

- **Labels, not names.** Docker sources keep the first container's labels
  (server memory only, never sent to the browser). The group is worked out on
  every `/api/sources` read, so changing the setting regroups live with no
  restart and no change to stored lines.
- **Modes** (Settings → General → Source grouping): **auto** (default):
  `quiet.group` label → `com.docker.compose.project` → `com.docker.stack.namespace`
  → Standalone. Compose comes before stack because Kwaame listed it that way
  (the first cut had stack first; a container rarely has both). The
  `quiet.group` override in auto was asked for "if trivial": it is one lookup.
  **label**: one Docker label key the owner names (default suggestion
  `quiet.group`); containers without it are Standalone. **off**: no groups;
  `group`/`group_kind` are `null` and every list is flat.
- **Pushed sources** (HTTP, Vector, Fluent Bit, OTLP) are one **Ingest** group
  in auto and label mode: they have no Docker labels.
- **Precedence: env wins and locks.** `QUIET_GROUP_BY` / `QUIET_GROUP_LABEL`
  (or `--group-by` / `--group-label`), when set, override the saved value and
  the control becomes read-only ("set by env"); `PUT /api/settings/grouping`
  answers 400. This is the opposite of storage (UI wins over flags). Kwaame
  first asked for UI > env, then the 07.11 board and his follow-up said env
  wins and locks; the later instruction is what is built.
- **Preview** (`GET /api/sources/grouping-preview?mode=&label=`) groups the
  current sources with a draft mode/label on the server, plus "found on N of
  M" for the label, so the Settings preview updates as the owner types without
  exposing labels (they can hold secrets, e.g. proxy auth).
- **UI**: Sources page (group rows with kind tag compose / stack / label /
  docker / push, `N/M sending · K shown`, aggregate lines/s, Search this group
  · 24h, ⋯ menu: search these N sources, collapse group, collapse all, copy
  project name, ignore all N; member dots on collapsed headers; "all stopped"
  tag + explanation row; indent guide on nested 36px rows), sidebar (compact
  headers, single-line 28px items, collapse/expand all), stream top-bar source
  picker (group / name; ↑↓ move, ← → fold, ↵ streams), ⌘K (sources under their
  group, a Groups section that opens `/sources?group=…`, "Search <group> ·
  24h"), and the All · Standalone · Compose / Stack filter (custom-label groups
  count as Compose / Stack). "Sending" = a line in the last 60 s.
- **Collapse state** is one list in localStorage (`quiet.source-groups.collapsed`),
  shared live by the Sources page, sidebar and picker. The open source stays
  visible in a collapsed sidebar group. Collapsed rows on the Sources page stay
  mounted (hidden) so the Erroring count and stopped banner still see them.
- **Ignore all N** = pause ingest + hide each source (the per-source settings
  already have both), after a confirm dialog; reversible per source. Stored
  lines stay until they expire.
- **Not built**: streaming a whole group. The stream stays one source at a
  time for v0.1; a group in ⌘K opens Sources, never the stream.
- The Sources page keeps the 06.1 stat cards above the filters (06.7 omits
  them; both are v0.1 boards).
