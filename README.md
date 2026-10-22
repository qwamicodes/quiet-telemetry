# quiet

A calm, realtime canonical-log viewer. Pick one source, watch only its lines, open any line as a flow.

Single binary (Rust) + a small React UI. v0.1 runs on one host and reads the local Docker socket.

## Status

Built in slices. Each slice is one PR to `main`, tested locally first, then promoted to production (see [Releases](#releases)).

| Slice | What | State |
|---|---|---|
| 1 | Docker receiver → normalize → per-source ring → WebSocket → stream view | merged |
| — | Foundation: CLI, Receiver/Store traits, embedded UI, shared types, UI kit | merged |
| 2 | SQLite (WAL, hourly partitions) + FTS5 search over the window, export (NDJSON/JSON/CSV, Copy curl), retention + disk cap job | this PR |
| 3 | Flows: stitch lines by every correlation id, field card | |
| 4 | HTTP ingest: Vector / Fluent Bit NDJSON, OTLP/HTTP logs + spans, ingest tokens | |
| 5 | Accounts: owner first-run, members, copy-link invites | |
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

What you should see:
- Sources on the left: `sample-api`, `sample-worker`, plus every other container running on your machine.
- Pick `sample-api`: new lines arrive every second, newest at the bottom.
- Click a line: the field card opens (Fields / JSON / Raw). Lines sharing a `request_id` with `sample-worker` are what flows will stitch (slice 3).
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

Open http://127.0.0.1:5173 (Vite proxies `/api` and `/ingest` to the server). Edit `web/src/**` and the page updates; edit `server/src/**` and the server restarts (with cargo-watch) or re-run `make dev`.

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

Not in Docker? Push lines over HTTP (one JSON object or plain text per line):

```sh
curl -X POST localhost:7070/ingest/ndjson -H 'X-Quiet-Source: my-app' \
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
| `--addr` / `QUIET_ADDR` | `127.0.0.1:7070` | Loopback until accounts land (slice 5). The image uses `0.0.0.0:7070`. |
| `--docker` / `QUIET_DOCKER` | `on` | `0`/`off` disables the Docker receiver. |
| `--ring` / `QUIET_RING` | `10000` | Live lines kept in memory per source (the stream backlog). |
| `--store` / `QUIET_STORE` | `sqlite` | `sqlite`: the searchable window on disk. `memory`: the live ring only, nothing survives a restart, search covers the ring. |
| `--data-dir` / `QUIET_DATA_DIR` | `data` (image: `/data`) | Where `quiet.db` (+ `-wal`) lives. **Mount a volume here** (`deploy/docker-compose.*.yml` do). |
| `--retention` / `QUIET_RETENTION` | `24h` | How long lines stay searchable, `1h` … `7d` (e.g. `3d`, `7d`). Whole hours are dropped, so a line can outlive it by up to an hour. |
| `--max-disk` / `QUIET_MAX_DISK` | `5GB` | Disk cap for the database (`500MB`, `5GB`, `1GiB`; min 10MB). Over it, the oldest hour goes first. Whichever of retention and cap hits first wins. |
| `--web-dir` / `QUIET_WEB_DIR` | embedded | Serve the UI from a directory instead of the copy built into the binary. |
| `--drain-ms` / `QUIET_DRAIN_MS` | `1000` | On SIGTERM, how long `/ready` is 503 before connections close. |
| `--shutdown-timeout-ms` / `QUIET_SHUTDOWN_TIMEOUT_MS` | `10000` | Hard limit for a graceful stop. |

`quiet agent` exists as a placeholder and exits non-zero until v0.2.

### Docker labels

Sources are named by `com.docker.swarm.service.name` → `com.docker.compose.service` → container name, so replicas merge into one source. Override with `quiet.source=<name>`, skip a container with `quiet.ignore=true`.

## Architecture

One host, one binary: `stream → flow → card`.

```
receivers ──► pipeline ──► store ──► hub ──► WebSocket ──► UI
(Docker,      normalize    (ring +   (per-source
 HTTP NDJSON,  + ids        SQLite)   broadcast)
 OTLP later)                  │
                              └──► /api/search · /api/export ──► Search UI
```

Server (`server/src`, one crate):

- `cli.rs`: clap; `server` (default), `agent` (stub), hidden `healthcheck` used by the image.
- `receiver/`: the `Receiver` trait. Pull receivers (`docker.rs`) run a loop; push receivers (`http.rs`) mount routes. OTLP and the v0.2 agent are new impls here.
- `pipeline.rs`: the only path a line takes: normalize → `Store::append` → hub broadcast, ids assigned in order.
- `store/`: the `Store` trait (`append`, `query` live tail, `search`, `expire`, `enforce_cap`, `flush`, `restore`, `usage`), `MemoryStore` (bounded ring per source; tests and `--store memory`) and `SqliteStore` (hourly partitions, FTS5, id index, ring in front). Per-minute rollups become another pipeline stage.
- `search.rs`: the query language and `SearchQuery`; `search_api.rs`: `/api/search`, `/api/export`, export tokens; `export.rs`: formats, PII masking, `qx_` tokens; `retention.rs`: the hourly drop job.
- `hub.rs`: source registry + per-source broadcast channel.
- `api.rs`: `/health`, `/ready`, `/api/*`, the stream WebSocket.
- `web.rs`: the built UI embedded with rust-embed (SPA fallback, ETags, immutable hashed assets, gzip/br).
- `server.rs`: wiring and graceful shutdown (SIGTERM → `/ready` 503 → drain → close streams with 1012 → stop receivers → timeout).
- `bindings.rs`: ts-rs exports the wire types to `web/src/gen/`; a test fails when they are stale (`make types` regenerates).

Web (`web/src`): React 19 + Vite + TypeScript, Tailwind v4 and shadcn/ui (Lyra) on Base UI, TanStack Router (`/`, `/search`, `/flow/$id`, `/settings`; search params are zod schemas), TanStack Query, TanStack Virtual, cmdk (⌘K), sileo (toasts), zod, lucide. `routes/` are pages, `components/` small pieces (`components/ui/` is the shadcn kit), `lib/` hooks and helpers (`use-stream.ts` is the WebSocket with jittered backoff). Biome lints and formats; Vitest + Testing Library test.

Keys: `/` filter · `j`/`k` move · `esc` close · `space` pause · `G` latest · `⌘K` jump.

## Releases

`main` is production. There is no staging branch: testing happens locally.

- Every push to `main` publishes `ghcr.io/qwamicodes/quiet-telemetry:sha-<sha>` (amd64 + arm64); a `vX.Y.Z` tag on `main` publishes `:X.Y.Z`. No `latest`. The job summary prints the digest.
- The `deploy-production` job waits for approval on the `production` GitHub Environment, then points the Dokploy app (deploy.legivent.com) at the image **by digest** and deploys. It skips cleanly until the Dokploy secrets exist.
- `deploy/docker-compose.prod.yml` is the reference for running it (digest-pinned, loopback port, healthcheck, memory limit).

See [CONTRIBUTING.md](CONTRIBUTING.md).

## How a line is read

- JSON first; anything else is kept as raw text (level sniffed from `ERROR`/`WARN`/…).
- Timestamp: `timestamp` / `time` / `ts` / `@timestamp` (ISO preferred, epoch s/ms/µs/ns ok), else Docker's timestamp, else arrival. Duplicate keys are tolerated and flagged.
- Level: pino numbers (10–60) or names.
- Every correlation id on the line is indexed (up to 4 levels deep, so a job's `data.request_id` counts). The row shows one by priority `request_id → job_id → trace_id → correlation_id`.

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

From the stream (top bar) or a search (Export): NDJSON (the raw lines; plain-text lines are wrapped as `{"time","source","level","message"}` so every row is JSON), a JSON array of parsed lines, or CSV with chosen columns (dot paths work). Options: gzip, **mask PII** (on by default: `email`, `phone`, `*_name`, `ip`/`ip_address`/`client_ip`/`x-forwarded-for`, `user_agent` keys, plus emails and IPv4 addresses inside any text), include the raw line. **Download** streams the file; **Copy curl** copies a command with a `qx_` token (read-only, this query only, single use, 15 min). Ingest tokens stay send-only.

## API

- `GET /health` (liveness) · `GET /ready` (readiness, 503 while shutting down)
- `GET /api/health` (now also `retention_ms`, `disk_bytes`, `stored_lines`, `oldest`) · `GET /api/sources` · `GET /api/sources/:name/lines?limit=`
- `GET /api/search?q=&source=a,b&level=&since=&until=&id=&order=newest|oldest&cursor=&limit=&buckets=` → `{ lines, next_cursor, total, bytes, histogram, searched, took_ms, since, until }`. Times are unix ms; missing bounds = the retention window ending now. `total`/`histogram` come with the first page when `buckets` is set.
- `GET /api/export?<search params>&format=ndjson|json|csv&gzip=1&mask=pii&raw=1&columns=a,b` streams a file (oldest first). Optional `Authorization: Bearer qx_…`.
- `POST /api/export/token {"query":"<export query string>"}` → `{ token, expires_at, path }`: a read-only `qx_` token for that one query, single use, 15 minutes; only its SHA-256 is kept (in memory).
- `WS /api/stream?source=&backlog=&level=&q=` → frames `backlog`, `lines` (batched every 75 ms), `gap` (client fell behind)
- `POST /ingest/ndjson` with `X-Quiet-Source`
