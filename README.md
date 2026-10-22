# quiet

A calm, realtime canonical-log viewer. Pick one source, watch only its lines, open any line as a flow.

Single binary (Rust) + a small React UI. v0.1 runs on one host and reads the local Docker socket.

## Status

Built in slices. Each slice is one PR to `main`, tested locally first, then promoted to production (see [Releases](#releases)).

| Slice | What | State |
|---|---|---|
| 1 | Docker receiver → normalize → per-source ring → WebSocket → stream view | merged |
| — | Foundation: CLI, Receiver/Store traits, embedded UI, shared types, UI kit | merged |
| 2 | SQLite (WAL, hourly partitions) + FTS5 search over the window, export (NDJSON/JSON/CSV, Copy curl), retention + disk cap job | PR #4 |
| 3 | Flows: stitch lines by every correlation id (request ↔ job), step nodes + timeline, field card per node, search grouped by flow | PR #6 |
| 4 | HTTP ingest: Vector, Fluent Bit, OTLP/HTTP logs + traces (span tree in flows), NDJSON/curl, `quiet pipe`; `qi_` ingest tokens; Connect a source + Sources + Settings → Ingest tokens screens | PR #7 |
| 5 | Accounts: owner first-run setup, sign in, members + copy-link invites, sessions, reset links; every `/api` route behind a session | this PR |
| 6 | Settings UI for retention / disk cap (the job itself ships in 2), storage + per-source settings | |

Every slice goes **local → main → prod**: built and checked locally (`make check`, `make up`), merged to `main` by PR, then deployed to production once the `production` environment approves the release.

## Getting started (local)

Follow these steps top to bottom. You should see live logs in about 10 minutes.

### 1. Install the tools (once)

| Tool | Why | Install | Check |
|---|---|---|---|
| Docker Desktop (macOS) or Docker Engine + Compose v2 (Linux) | runs quiet and reads container logs | https://docs.docker.com/get-docker/ | `docker compose version` |
| Git | clone the repo | already on most machines | `git --version` |
| Bun 1.4+ | the web UI and the sample generator (only for `make dev` / `make check` / `make sample`) | `curl -fsSL https://bun.sh/install \| bash` | `bun -v` |
| Rust stable | the server (only for `make dev` / `make check`) | `curl https://sh.rustup.rs -sSf \| sh` | `cargo -V` |
| make | the shortcuts below | macOS: `xcode-select --install` | `make -v` |
| cargo-watch (optional) | restarts the server when you save | `cargo install cargo-watch` | |

Only want to try it? Docker + Git + make is enough (path A).

### 2. Get the code

```sh
git clone https://github.com/qwamicodes/quiet-telemetry.git
cd quiet-telemetry
git checkout main   # until the open PRs merge, use: git checkout foundation/structure
```

### 3A. Run everything in Docker (easiest)

```sh
make up      # builds quiet from source + starts a sample log generator
```

Open http://127.0.0.1:7070. The first build takes a few minutes (Rust); later ones are cached.

The first visit asks you to **set up quiet**: your name, email and a password (12+ characters). That account is the owner. After that, quiet always asks you to sign in (see [Accounts](#accounts)).

What you should see:
- Sources on the left: `sample-api`, `sample-worker`, plus every other container running on your machine.
- Pick `sample-api`: new lines arrive every second, newest at the bottom.
- Click a line: the field card opens (Fields / JSON / Raw). Press **Enter** (or the fork icon on the card) to open it as a flow: the API request, the `sample-worker` job it enqueued (same `request_id`) and the job's retries, as step nodes with a timeline.
- **Search** (sidebar): try `payout level:>=warn`, click a `request_id` value to narrow, switch *Group by flow* / *Lines*, then **Export** (CSV, gzip, Copy curl).
- Restart (`make down && make up`): the sources, ids and search history are still there (the `quiet-data` volume).

Useful while it runs:

```sh
make logs    # quiet's own logs
make down    # stop and remove the stack
```

### 3B. Run it for development (hot reload)

```sh
(cd web && bun install)   # once, and after package.json changes
make dev              # server on :7070 + UI on :5173 with hot reload
make sample           # second terminal: sample lines over HTTP
```

Open http://127.0.0.1:5173 (Vite proxies `/api`, `/ingest` and `/v1` to the server) and create the owner account the first time (it lives in `server/data/quiet.db`). `make dev` runs with `QUIET_INGEST_AUTH=open` so `make sample` needs no token; `QUIET_INGEST_AUTH=token make dev` tries the token flow. Working on something unrelated to accounts? `QUIET_AUTH=off make dev` skips sign-in entirely (loopback only; see [Accounts](#accounts)). Edit `web/src/**` and the page updates; edit `server/src/**` and the server restarts (with cargo-watch) or re-run `make dev`.

The server also reads your local Docker socket here, so your running containers show up too. Turn that off with `QUIET_DOCKER=off make dev`.

### 4. Point your own apps at it

Any container on the same machine shows up automatically: quiet reads its stdout/stderr through the Docker socket. Names come from the Swarm service, then the Compose service, then the container name.

```yaml
# in your app's compose file (optional labels)
services:
  legivent-api:
    labels:
      quiet.source: legivent-api   # rename the source
  redis:
    labels:
      quiet.ignore: "true"         # hide noisy containers
```

Not in Docker, or already shipping logs with Vector, Fluent Bit or OpenTelemetry? Open **Connect a source** in the UI: it creates an ingest token and gives you the config with your URL and token filled in. Or by hand (see [Ingest](#ingest)):

```sh
TOKEN=qi_…   # Settings → Ingest tokens → Create token
curl -X POST localhost:7070/ingest/ndjson -H "Authorization: Bearer $TOKEN" -H 'X-Quiet-Source: my-app' \
  --data-binary $'{"level":30,"msg":"hello","request_id":"req_1"}\nplain text works too'
```

For the best flows, follow the logging guide: one canonical JSON line per request or job attempt, `request_id` on every line, jobs carry the parent `request_id`, timed calls in `wideEvents.calls`.

### 5. Before you push

```sh
make check   # exactly what CI runs: web lint/typecheck/test/build, cargo fmt/clippy/test
make types   # only if you changed a Rust type the UI uses (regenerates web/src/gen)
make build   # optional: one release binary at server/target/release/quiet with the UI inside
```

### Troubleshooting

| Problem | Fix |
|---|---|
| No containers in the source list | Docker isn't reachable. Check `docker ps` works. On Linux add yourself to the `docker` group (`sudo usermod -aG docker $USER`, then log out/in). With Colima/OrbStack/rootless Docker, set `DOCKER_HOST` (e.g. `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`) for `make dev`; for `make up`, change the socket path in `deploy/docker-compose.local.yml`. |
| `port 7070 is already allocated` / `address in use` | Something else is on 7070: `make down`, or run with `QUIET_ADDR=127.0.0.1:7171 make dev`. |
| UI shows "Reconnecting…" forever | The server isn't running or crashed: check the `make dev` terminal or `make logs`. |
| Blank page at :7070 after `cargo run` | The binary embeds the UI at build time: run `cd web && bun run build` first (or use `make build` / `make dev`). |
| `make check` fails on stale types | Run `make types` and commit `web/src/gen`. |
| `cargo fmt`/`clippy` errors | `cd server && cargo fmt` then fix what clippy prints; CI uses `-D warnings`. |
| First `make up` is slow | Normal: Rust compiles everything once. Later builds reuse the cache. |
| Sample lines missing | `make sample` needs the server running first; in Docker, `docker compose -f deploy/docker-compose.local.yml logs sample`. |

## Reference

### Config

Every flag also reads its env var (`quiet --help`). `quiet` with no subcommand is `quiet server`.

| Flag / Env | Default | |
|---|---|---|
| `--addr` / `QUIET_ADDR` | `127.0.0.1:7070` | The image uses `0.0.0.0:7070`. Everything except `/health`, `/ready` and token-gated ingest needs a signed-in session, so listening on all interfaces is fine; put TLS in front (a reverse proxy) for anything beyond your machine. |
| `--auth` / `QUIET_AUTH` | `on` | `on`: accounts and sign-in. `off`: no sign-in, every request acts as a local owner, for local development only; the server refuses to start with `off` unless `--addr` is a loopback address. |
| `--cookie-secure` / `QUIET_COOKIE_SECURE` | `auto` | `Secure` flag on the session cookie. `auto`: set when the proxy says the request came over https (`X-Forwarded-Proto: https`). `on` / `off` force it. |
| `--trust-proxy` / `QUIET_TRUST_PROXY` | `off` | Take the client address from `X-Forwarded-For` (rightmost hop) / `X-Real-IP`, for sign-in backoff and the sessions list. Turn on only when a reverse proxy you run sets those headers and quiet isn't reachable around it. |
| `--docker` / `QUIET_DOCKER` | `on` | `0`/`off` disables the Docker receiver. |
| `--ring` / `QUIET_RING` | `10000` | Live lines kept in memory per source (the stream backlog). |
| `--store` / `QUIET_STORE` | `sqlite` | `sqlite`: the searchable window on disk. `memory`: the live ring only, nothing survives a restart, search covers the ring. |
| `--data-dir` / `QUIET_DATA_DIR` | `data` (image: `/data`) | Where `quiet.db` (+ `-wal`) lives. **Mount a volume here** (`deploy/docker-compose.*.yml` do). |
| `--retention` / `QUIET_RETENTION` | `24h` | How long lines stay searchable, `1h` … `7d` (e.g. `3d`, `7d`). Whole hours are dropped, so a line can outlive it by up to an hour. |
| `--max-disk` / `QUIET_MAX_DISK` | `5GB` | Disk cap for the database (`500MB`, `5GB`, `1GiB`; min 10MB). Over it, the oldest hour goes first. Whichever of retention and cap hits first wins. |
| `--web-dir` / `QUIET_WEB_DIR` | embedded | Serve the UI from a directory instead of the copy built into the binary. |
| `--drain-ms` / `QUIET_DRAIN_MS` | `1000` | On SIGTERM, how long `/ready` is 503 before connections close. |
| `--shutdown-timeout-ms` / `QUIET_SHUTDOWN_TIMEOUT_MS` | `10000` | Hard limit for a graceful stop. |
| `--ingest-auth` / `QUIET_INGEST_AUTH` | `token` | `token`: every HTTP ingest request needs a `qi_` ingest token. `open`: tokenless requests are accepted too (local development; `make dev` and the local compose use it). A token that is sent is always checked. |
| `--ingest-max-body` / `QUIET_INGEST_MAX_BODY` | `16MB` | Largest ingest body, checked before and after gzip (1KB … 1GB). Over it: 413. |
| `--ingest-rate` / `QUIET_INGEST_RATE` | `20000` | Lines per second per ingest token, bursts of 5 s worth; `0` = unlimited. Over it: 429 + `Retry-After`. |

`quiet agent` exists as a placeholder and exits non-zero until v0.2. `quiet pipe --name <source> [--url http://127.0.0.1:7070] [--token qi_…]` sends stdin to a server (see [Ingest](#ingest)). `quiet admin reset-password <email> [--data-dir data] [--url https://quiet.example.com]` prints a one-time reset link (see [Accounts](#accounts)).

### Docker labels

Sources are named by `com.docker.swarm.service.name` → `com.docker.compose.service` → container name, so replicas merge into one source. Override with `quiet.source=<name>`, skip a container with `quiet.ignore=true`.

## Architecture

One host, one binary: `stream → flow → card`.

```
receivers ──► pipeline ──► store ──► hub ──► WebSocket ──► UI
(Docker,      normalize    (ring +   (per-source
 HTTP: NDJSON, + ids        SQLite)   broadcast)
 Vector, Fluent Bit,          │
 OTLP/HTTP; qi_ tokens)       │
                              └──► /api/search · /api/export ──► Search UI
```

Server (`server/src`, one crate):

- `cli.rs`: clap; `server` (default), `agent` (stub), hidden `healthcheck` used by the image.
- `receiver/`: the `Receiver` trait. Pull receivers (`docker.rs`) run a loop; push receivers mount routes: `http.rs` (all HTTP ingest: auth, gzip, body cap, rate limit), `shippers.rs` (NDJSON / Vector / Fluent Bit bodies → lines, envelope unwrapping, source naming), `otlp.rs` (OTLP/HTTP protobuf + JSON → canonical JSON lines; prost messages declared by hand, no protoc). OTLP/gRPC and the v0.2 agent are new impls here.
- `accounts.rs`: users, sessions, invites and reset links in `quiet.db` (argon2id; session ids and link tokens stored as SHA-256), no HTTP in it. `auth.rs`: the session gate in front of `/api`, cookies, CSRF/same-origin checks, sign-in backoff. `auth_api.rs`: `/api/auth/*`, `/api/account*`, `/api/members*`, `/api/invites*`. `admin.rs`: `quiet admin reset-password`.
- `tokens.rs`: `qi_` ingest tokens (SHA-256 only, `ingest_tokens` table in `quiet.db`, cached in memory, per-token rate bucket); `tokens_api.rs`: `/api/ingest-tokens`.
- `pipe.rs`: `quiet pipe`, stdin → `/ingest/ndjson` over plain HTTP.
- `pipeline.rs`: the only path a line takes: normalize → `Store::append` → hub broadcast, ids assigned in order.
- `store/`: the `Store` trait (`append`, `query` live tail, `search`, `expire`, `enforce_cap`, `flush`, `restore`, `usage`), `MemoryStore` (bounded ring per source; tests and `--store memory`) and `SqliteStore` (hourly partitions, FTS5, id index, ring in front). Per-minute rollups become another pipeline stage.
- `flow.rs`: stitching (a bounded walk over the id index) and shaping lines into step nodes + edges; `flow_api.rs`: `/api/flow`, `/api/flow-summaries`.
- `search.rs`: the query language and `SearchQuery`; `search_api.rs`: `/api/search`, `/api/export`, export tokens; `export.rs`: formats, PII masking, `qx_` tokens; `retention.rs`: the hourly drop job.
- `hub.rs`: source registry + per-source broadcast channel.
- `api.rs`: `/health`, `/ready`, `/api/*`, the stream WebSocket.
- `web.rs`: the built UI embedded with rust-embed (SPA fallback, ETags, immutable hashed assets, gzip/br).
- `server.rs`: wiring and graceful shutdown (SIGTERM → `/ready` 503 → drain → close streams with 1012 → stop receivers → timeout).
- `bindings.rs`: ts-rs exports the wire types to `web/src/gen/`; a test fails when they are stale (`make types` regenerates).

Web (`web/src`): React 19 + Vite + TypeScript, Tailwind v4 and shadcn/ui (Lyra) on Base UI, TanStack Router (`/`, `/search`, `/flow/$id`, `/line/$lineId`, `/connect?kind=`, `/sources`, `/settings`, `/settings/account`, `/settings/members`, `/settings/ingest-tokens`; signed out: `/setup`, `/signin?redirect=`, `/invite/$token`, `/reset/$token`; the root route's `beforeLoad` sends signed-out visitors to sign in; search and path params are zod schemas), TanStack Query, TanStack Virtual, cmdk (⌘K), sileo (toasts), zod, lucide. `routes/` are pages, `components/` small pieces (`components/ui/` is the shadcn kit), `lib/` hooks and helpers (`use-stream.ts` is the WebSocket with jittered backoff). Biome lints and formats; Vitest + Testing Library test.

Keys: `/` filter · `j`/`k` move · `enter` open flow · `esc` close · `space` pause · `G` latest · `⌘K` jump.

## Releases

`main` is production. There is no staging branch: testing happens locally.

- Every push to `main` publishes `ghcr.io/qwamicodes/quiet-telemetry:sha-<sha>` (amd64 + arm64); a `vX.Y.Z` tag on `main` publishes `:X.Y.Z`. No `latest`. The job summary prints the digest.
- The `deploy-production` job waits for approval on the `production` GitHub Environment, then points the Dokploy app (deploy.legivent.com) at the image **by digest** and deploys. It skips cleanly until the Dokploy secrets exist.
- `deploy/docker-compose.prod.yml` is the reference for running it (digest-pinned, loopback port, healthcheck, memory limit).

See [CONTRIBUTING.md](CONTRIBUTING.md). Technical decisions per slice: [docs/decisions.md](docs/decisions.md).

## How a line is read

- JSON first; anything else is kept as raw text (level sniffed from `ERROR`/`WARN`/…).
- Timestamp: `timestamp` / `time` / `ts` / `@timestamp` (ISO preferred, epoch s/ms/µs/ns ok), else Docker's timestamp, else arrival. Duplicate keys are tolerated and flagged.
- Level: pino numbers (10–60) or names.
- Every correlation id on the line is indexed (up to 4 levels deep, so a job's `data.request_id` counts). The row shows one by priority `request_id → job_id → trace_id → correlation_id`.

## Flows

A flow is every line that shares a correlation id (`request_id`, `job_id`, `trace_id`, `correlation_id`, any spelling the normalizer knows, up to 4 levels deep so `data.request_id` counts), stitched across ids:

- Opening an id finds every line carrying it (the id index, all sources, the retention window), then follows the *other* ids on those lines. A worker line with `job_id` + `request_id` joins the request to its job, and the job's retry lines (which may carry only `job_id`) come along. Pass `request_id` into your BullMQ job data and log it on the worker.
- The walk is bounded: 2 hops past the opened id, 64 ids, 1000 lines. Hitting a limit marks the flow "cut at the flow size limit" instead of failing, so a hot id (a constant `trace_id`) can't pull in the whole window.
- Each line is a step node, ordered by when its work started (`time − duration_ms`; a canonical line is written when the work ends). `wideEvents.calls` / `wideEvents.steps` (`{name | provider+action, at_ms, duration_ms, ok, status, error}`) become child steps.
- Edges: `next` within a source, `retry` between attempts of one job (`attempt` / `retry_attempt` rising; the gap is the backoff), `handoff` across sources labelled with the shared id.
- A step is an error at level ≥ error, status ≥ 500 or `outcome: failed`; a warning at level warn, 4xx or `outcome: retry|timeout|partial|…`. The flow failed when the last step of any source (or the request) failed.
- A line with one id and nothing else sharing it is a one-node flow: just its field card. A line with no ids opens the same way (`/line/<id>`).

Traces: lines with OTLP span ids (spans sent to `/v1/traces`, or any line with `span_id` + `parent_span_id`) form a span tree inside their flow (they stitch by `trace_id`). Each span sits under its parent span (indented, with an "in <parent>" edge), and log records carrying a `span_id` sit under that span. Span events become child steps. The flow header says "span tree".

UI: `/flow/<id>?line=<line id>` (the step whose card is open) and `/line/<line id>`. `j`/`k` move between steps. The stream's **Steps** column and search's **Group by flow** use `/api/flow-summaries`, so a request and its job's retry lines land in one group ("2 of 5 lines match · 6 steps").

## Search

The box takes free text and filters, the same string the URL and the export curl carry:

```
dealer 88 level:>=warn source:order-worker status:500 -path:/health "exact phrase" -noise
```

- words and `"phrases"` match the whole raw line (FTS5; every word is a prefix, so `dealer` finds `dealers`); `-word` excludes
- `level:warn` (or `>=warn`): minimum level · `source:name` (repeatable)
- `id:…`, `request_id:…`, `job_id:…`, `trace_id:…`, `correlation_id:…`: any line carrying that id (indexed)
- any other `key:value`: that field equals the value (`err.code:TIMEOUT` walks dots); `-key:value` excludes
- click any value in a result to add it as a filter

## Storage

SQLite (bundled, WAL) in `--data-dir`. One set of tables per hour: the lines (only the raw line is stored; fields and ids are re-derived when read), a contentless FTS5 index over the raw line, and a side index of every correlation id. A writer thread coalesces queued lines into one transaction; the in-memory ring in front serves the live stream and is warmed from disk on start, so ids, sources and the backlog survive restarts. Every minute the retention job drops hours older than `--retention`, then the oldest hours while the database is over `--max-disk`, and hands the pages back to the OS (incremental vacuum).

## Export

From the stream (top bar) or a search (Export): NDJSON (the raw lines; plain-text lines are wrapped as `{"time","source","level","message"}` so every row is JSON), a JSON array of parsed lines, or CSV with chosen columns (dot paths work). Options: gzip, **mask PII** (on by default: `email`, `phone`, `*_name`, `ip`/`ip_address`/`client_ip`/`x-forwarded-for`, `user_agent` keys, plus emails and IPv4 addresses inside any text), include the raw line. **Download** streams the file; **Copy curl** copies a command with a `qx_` token (read-only, this query only, reusable for 15 min). Ingest tokens stay send-only.

## API

Every `/api` route needs a session cookie except the public auth routes, and every non-GET request also needs the `X-Quiet-Csrf` header (see [Accounts](#accounts)). Without a session: `401 { error, code: "session_required" | "session_expired" }`. `/health`, `/ready` and the ingest endpoints don't use sessions.

- `GET /health` (liveness) · `GET /ready` (readiness, 503 while shutting down)
- `GET /api/health` (now also `retention_ms`, `disk_bytes`, `stored_lines`, `oldest`) · `GET /api/sources` · `GET /api/sources/:name/lines?limit=`
- `GET /api/search?q=&source=a,b&level=&since=&until=&id=&order=newest|oldest&cursor=&limit=&buckets=` → `{ lines, next_cursor, total, bytes, histogram, searched, took_ms, since, until }`. Times are unix ms; missing bounds = the retention window ending now. `total`/`histogram` come with the first page when `buckets` is set.
- `GET /api/export?<search params>&format=ndjson|json|csv&gzip=1&mask=pii&raw=1&columns=a,b` streams a file (oldest first). With `Authorization: Bearer qx_…` it needs no session (the token is the credential). Members always get PII masked.
- `POST /api/export/token {"query":"<export query string>"}` → `{ token, expires_at, path }`: a read-only `qx_` token for that one query, reusable for 15 minutes; only its SHA-256 is kept (in memory). Members only get one for a masked query (`mask=pii`), else 403 `mask_required`.
- `GET /api/flow?id=<any id>` or `?line=<line id>` → `{ flow, since, until, took_ms }`: `flow` has the header numbers (`title`, `status`, `line_count`, `steps`, `sources`, `duration_ms`, `retries`, `stitched_by`, `truncated`), `nodes`, `edges`, the `lines` themselves, `missing_parent` (a request id the jobs carry whose own line isn't in the window) and `partial`. Unknown id → 404 `{ error, id, close: [{ key, value, msg, ts, source }] }` (ids with the same prefix). Ids go in the query string, so any id works.
- `POST /api/flow-summaries {"ids":[…]}` (≤ 100) → `{ flows: [{ id, flow: <header numbers> | null }] }`; ids of one flow share its `key`.
- `WS /api/stream?source=&backlog=&level=&q=` → frames `backlog`, `lines` (batched every 75 ms), `gap` (client fell behind). The upgrade must be same-origin; the stream re-checks its session every 30 s and closes with code 4401 once it ends.
- `GET /api/ingest-tokens` → `{ tokens: [{ id, name, preview: "qi_••••1a77", source | null, created, last_used, revoked }] }` · `POST /api/ingest-tokens {"name","source"?}` → `201 { token, secret }` (the secret only here) · `DELETE /api/ingest-tokens/:id` → the revoked token. Anyone signed in can list; only owners create and revoke (else 403 `owner_only`).
- `GET /api/health` also carries `ingest: { auth, loopback, max_body, rate, tokens }`.
- Accounts (public, no session): `GET /api/auth/state` → `{ auth: "on"|"off", setup_required, user, csrf, version, host }` · `POST /api/auth/setup {name,email,password}` (first run only, else 409) · `POST /api/auth/login {email,password,remember?}` (401 / 429 + `Retry-After`) · `POST /api/auth/invite {token}` → the invite, or 410 `{ code: expired|used|revoked, invite }` · `POST /api/auth/invite/accept {token,name,email?,password}` · `POST /api/auth/reset {token}` → `{ email, name, expires }` · `POST /api/auth/reset/accept {token,password}` → 204. Sign-in routes answer `{ user, csrf }` and set the cookie.
- Accounts (session): `POST /api/auth/logout` · `GET`/`PATCH /api/account {name,email,password?}` (changing the email needs the password) · `POST /api/account/password {current,password}` → `{ user, signed_out }` (other sessions signed out) · `GET /api/account/sessions` · `DELETE /api/account/sessions/:id` · `POST /api/account/sessions/sign-out-others` · `GET /api/members` → `{ members, invites }` (invites for owners only).
- Accounts (owner): `POST /api/invites {email?,role}` → `201 { invite, token, path }` · `DELETE /api/invites/:id` · `PATCH /api/members/:id {role}` · `DELETE /api/members/:id` · `POST /api/members/:id/reset-link` → `{ token, path, expires }`. Removing or demoting the last owner: 409 `last_owner`.
- Ingest (each needs `Authorization: Bearer qi_…`, see [Ingest](#ingest)): `POST /ingest/ndjson`, `POST /ingest/vector`, `POST /ingest/fluentbit`, `POST /v1/logs`, `POST /v1/traces`.

## Accounts

Local accounts, email + password. No mail is ever sent in v0.1.

- **First run.** While quiet has no users, every page goes to **Set up quiet**, and whoever completes it becomes the **owner** (the server logs a warning until then, so set it up right after the first start). Setup works exactly once.
- **Roles.** **Owner**: everything, plus members, invites, reset links, ingest tokens, and exports with PII unmasked. **Member**: reads every source, flow and search; exports always have PII masked; can manage only their own account (name, email, password, sessions). There is always at least one owner: the last one can't be demoted or removed. More than one owner is fine.
- **Invites** (Settings → Members): an owner creates a copy link (`/invite/inv_…`), optionally for one email address (the invite page then locks it), as member or owner. Links work once and expire after 7 days; only their SHA-256 is stored, so a lost link can't be shown again: make a new one (the old one is revoked). Email invites come in v0.2.
- **Sessions.** Signing in sets `quiet_session`: HttpOnly, SameSite=Lax, `Secure` behind https. "Keep me signed in" lasts 30 days; without it the cookie ends with the browser and the server forgets it after 12 hours. Sessions live in `quiet.db` (hashed ids), so a restart keeps everyone signed in. Settings → Account lists your sessions and signs out one or all others; changing your password signs out the others too. When a session ends while a page is open (signed out elsewhere, removed by an owner, expired), quiet asks for your password over the page and you carry on where you were.
- **Forgot a password.** An owner opens Settings → Members → ⋯ → *Password reset link* and sends the link (one use, 24 hours, signs that person out everywhere). A locked-out owner runs on the host: `quiet admin reset-password you@example.com --url https://quiet.example.com` (in Docker: `docker exec <container> /quiet admin reset-password you@example.com`) and opens the printed link within an hour.
- **Protection.** Passwords are hashed with argon2id. Sign-in backs off per email (5 free failures) and per client address (20), doubling the wait up to 15 minutes (429 + `Retry-After`). Writes need the session's CSRF token (`X-Quiet-Csrf`, handed out by `/api/auth/state` and sign-in) and must be same-origin (`Origin`/`Referer` vs `Host`/`X-Forwarded-Host`; `Sec-Fetch-Site: cross-site` is refused); so must the stream's WebSocket upgrade. Responses carry `X-Frame-Options: DENY` and `Referrer-Policy: same-origin` (link tokens never leak in a Referer).
- **What needs no session.** `/health`, `/ready`; ingest with a `qi_` token; `GET /api/export` with a `qx_` token from Copy curl.
- **Behind a proxy.** Forward `Host` (or set `X-Forwarded-Host`) and `X-Forwarded-Proto`; set `QUIET_TRUST_PROXY=on` so backoff and the sessions list see real client addresses.
- **`QUIET_AUTH=off`.** No accounts at all: every request is a local owner. For local development only, and only on a loopback address (the server refuses otherwise). Default is `on` everywhere, including `make dev` and the compose files.
- Accounts are always kept on disk under `--data-dir`, even with `--store memory` (losing them on restart would offer owner setup to whoever arrived first).

## Ingest

Docker needs nothing (quiet reads the socket). Everything else pushes over HTTP with an **ingest token**: `qi_…`, send-only (it can push lines, nothing else; read-only `qx_` export tokens are separate). Create one in **Settings → Ingest tokens**, or let **Connect a source** make one and fill it into the config for you. Only its SHA-256 is stored, so the token is shown once. A token is bound to one source (every line it sends lands there) or to all sources (the shipper names them). Revoking takes effect on the next request; last used is shown per token.

| Endpoint | For | Source name (unless the token is bound) |
|---|---|---|
| `POST /ingest/vector` | Vector `http` sink, `encoding.codec = "json"` (NDJSON or one array) | `X-Quiet-Source`, else the event's `source` / `service` / `container_name`, else `vector` |
| `POST /ingest/fluentbit` | Fluent Bit `http` output, `Format json_lines` (or `json`, `json_stream`) | `X-Quiet-Source`, else the tag (`Header_tag X-Quiet-Tag`; `legivent.api` → `legivent-api`), else the record's `source` / `service` / `container_name`, else `fluent-bit` |
| `POST /v1/logs`, `POST /v1/traces` | OTLP/HTTP, `application/x-protobuf` or JSON | `X-Quiet-Source`, else the resource's `service.name`, else `otlp` |
| `POST /ingest/ndjson` | curl, `quiet pipe`, anything: one JSON object or text line per row | `X-Quiet-Source`, else `http` |

- Shippers wrap the app's line (`{"message": "<line>", "container_name": …}` from Vector's `docker_logs`, `{"log": "<line>", "date": …}` from Fluent Bit). quiet stores the app's own line when the message is a JSON object, or when everything around it is collector metadata, so its ids stitch flows; the shipper's time becomes the collector timestamp. Events with their own fields are kept whole.
- OTLP log records become `{ timestamp, level, msg, service, trace_id, span_id, …attributes, …body fields, resource, scope }`; spans become `{ timestamp (end), level (error when the status is ERROR), name, otel.type: "span", span.kind, duration_ms, trace_id, span_id, parent_span_id, otel.status_code, …attributes, steps (events) }`. gRPC comes in v0.2.
- Bodies may be gzip (or deflate). Limits: `QUIET_INGEST_MAX_BODY` (413), `QUIET_INGEST_RATE` per token (429 + `Retry-After`; a limited batch is not stored, so the shipper's retry resends it whole). Missing/unknown/revoked token: 401 with the reason. Rejected requests are logged, their bodies are not.
- **Remote shippers:** the binary listens on `127.0.0.1:7070` by default. Shippers on other machines need `QUIET_ADDR=0.0.0.0:7070` (the image already uses it; publish the port or route it through your proxy). Ingest is gated by `qi_` tokens and the UI and `/api` by sign-in, so exposing quiet is fine; use TLS (a reverse proxy) so tokens and passwords never cross the network in clear text.

Vector (`vector.toml`):

```toml
[sinks.quiet]
type = "http"
inputs = ["docker_logs"]
uri = "https://quiet.example.com/ingest/vector"
encoding.codec = "json"
framing.method = "newline_delimited"
compression = "gzip"
auth.strategy = "bearer"
auth.token = "qi_…"
```

Fluent Bit (`fluent-bit.conf`):

```ini
[OUTPUT]
    Name             http
    Match            *
    Host             quiet.example.com
    Port             443
    URI              /ingest/fluentbit
    Format           json_lines
    Json_date_key    date
    Json_date_format epoch
    Header_tag       X-Quiet-Tag
    Header           Authorization Bearer qi_…
    Compress         gzip
    tls              On
```

OpenTelemetry SDK (env) or Collector:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=https://quiet.example.com
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer qi_…"
OTEL_SERVICE_NAME=payments-svc
```

```yaml
exporters:
  otlphttp/quiet:
    endpoint: https://quiet.example.com
    headers: { authorization: Bearer qi_… }
service:
  pipelines:
    logs: { receivers: [otlp], exporters: [otlphttp/quiet] }
    traces: { receivers: [otlp], exporters: [otlphttp/quiet] }
```

curl, a file, or a process:

```sh
curl -X POST https://quiet.example.com/ingest/ndjson -H 'Authorization: Bearer qi_…' \
  -H 'X-Quiet-Source: cron-runner' --data-binary @app.log
bun run start | quiet pipe --name legivent-api --token qi_…   # plain http only; echoes stdin
```
