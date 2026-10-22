# quiet

A calm, realtime canonical-log viewer. Pick one source, watch only its lines, open any line as a flow.

Single binary (Rust) + a small React UI. v0.1 runs on one host and reads the local Docker socket.

## Status

Built in slices. Each slice is one PR to `main`, tested locally first, then promoted to production (see [Releases](#releases)).

| Slice | What | State |
|---|---|---|
| 1 | Docker receiver → normalize → per-source ring → WebSocket → stream view | PR #1 |
| — | Foundation: CLI, Receiver/Store traits, embedded UI, shared types, UI kit | this PR |
| 2 | SQLite (WAL, hourly partitions) + FTS5 search over the window | next |
| 3 | Flows: stitch lines by every correlation id, field card | |
| 4 | HTTP ingest: Vector / Fluent Bit NDJSON, OTLP/HTTP logs + spans, ingest tokens | |
| 5 | Accounts: owner first-run, members, copy-link invites | |
| 6 | Retention (1h/24h/3d/7d), ~5 GB cap, storage + per-source settings | |

Every slice goes **local → main → prod**: built and checked locally (`make check`, `make up`), merged to `main` by PR, then deployed to production once the `production` environment approves the release.

## Run locally

Needs Rust (stable), Node 22, and Docker for the compose stack.

```sh
make dev     # server on :7070 (cargo watch if installed) + Vite on :5173 with hot reload
make sample  # in another terminal: realistic lines for sample-api + sample-worker over HTTP
make up      # or: the whole thing in Docker, built from source, plus the sample generator
make down
make check   # what CI runs: web lint/typecheck/test/build, cargo fmt/clippy/test
```

`make up` uses `deploy/docker-compose.local.yml`: quiet reads every container on the local socket, and the sample generator emits canonical JSON lines, an HTTP API (`wideEvents.calls`) on stdout and BullMQ-style payout jobs with retries (sharing the API's `request_id`) over `/ingest/ndjson`. Open http://127.0.0.1:7070.

Send your own lines without Docker:

```sh
curl -X POST localhost:7070/ingest/ndjson -H 'X-Quiet-Source: api' \
  --data-binary $'{"level":30,"msg":"hello","request_id":"req_1"}\nplain text works too'
```

### Config

Every flag also reads its env var (`quiet --help`). `quiet` with no subcommand is `quiet server`.

| Flag / Env | Default | |
|---|---|---|
| `--addr` / `QUIET_ADDR` | `127.0.0.1:7070` | Loopback until accounts land (slice 5). The image uses `0.0.0.0:7070`. |
| `--docker` / `QUIET_DOCKER` | `on` | `0`/`off` disables the Docker receiver. |
| `--ring` / `QUIET_RING` | `10000` | Live lines kept in memory per source. |
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
(Docker,      normalize    (ring     (per-source
 HTTP NDJSON,  + ids        today,    broadcast)
 OTLP later)                SQLite
                            slice 2)
```

Server (`server/src`, one crate):

- `cli.rs`: clap; `server` (default), `agent` (stub), hidden `healthcheck` used by the image.
- `receiver/`: the `Receiver` trait. Pull receivers (`docker.rs`) run a loop; push receivers (`http.rs`) mount routes. OTLP and the v0.2 agent are new impls here.
- `pipeline.rs`: the only path a line takes: normalize → `Store::append` → hub broadcast, ids assigned in order.
- `store/`: the `Store` trait (`append`, `query`, `tail`, `expire`) and `MemoryStore` (bounded ring per source). Slice 2 adds SQLite behind the same trait; per-minute rollups become another pipeline stage.
- `hub.rs`: source registry + per-source broadcast channel.
- `api.rs`: `/health`, `/ready`, `/api/*`, the stream WebSocket.
- `web.rs`: the built UI embedded with rust-embed (SPA fallback, ETags, immutable hashed assets, gzip/br).
- `server.rs`: wiring and graceful shutdown (SIGTERM → `/ready` 503 → drain → close streams with 1012 → stop receivers → timeout).
- `bindings.rs`: ts-rs exports the wire types to `web/src/gen/`; a test fails when they are stale (`make types` regenerates).

Web (`web/src`): React 19 + Vite + TypeScript, Tailwind v4 and shadcn/ui (Lyra) on Base UI, TanStack Router (`/`, `/flow/$id`, `/settings`), TanStack Query, TanStack Virtual, cmdk (⌘K), sonner, lucide. `routes/` are pages, `components/` small pieces (`components/ui/` is the shadcn kit), `lib/` hooks and helpers (`use-stream.ts` is the WebSocket with jittered backoff). Biome lints and formats; Vitest + Testing Library test.

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

## API

- `GET /health` (liveness) · `GET /ready` (readiness, 503 while shutting down)
- `GET /api/health` · `GET /api/sources` · `GET /api/sources/:name/lines?limit=`
- `WS /api/stream?source=&backlog=&level=&q=` → frames `backlog`, `lines` (batched every 75 ms), `gap` (client fell behind)
- `POST /ingest/ndjson` with `X-Quiet-Source`
