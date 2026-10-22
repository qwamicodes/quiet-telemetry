# quiet

A calm, realtime canonical-log viewer. Pick one source, watch only its lines, open any line as a flow.

Single binary (Rust) + a small React UI. v0.1 runs on one host and reads the local Docker socket.

## Status

Built in slices. Each slice is one PR.

| Slice | What | State |
|---|---|---|
| 1 | Docker receiver → normalize → per-source ring → WebSocket → stream view | this PR |
| 2 | SQLite (WAL, hourly partitions) + FTS5 search over the window | next |
| 3 | Flows: stitch lines by every correlation id, field card | |
| 4 | HTTP ingest: Vector / Fluent Bit NDJSON, OTLP/HTTP logs + spans, ingest tokens | |
| 5 | Accounts: owner first-run, members, copy-link invites | |
| 6 | Retention (1h/24h/3d/7d), ~5 GB cap, storage + per-source settings | |

## Run it

```sh
# server (reads /var/run/docker.sock or DOCKER_HOST)
cd server && cargo run

# ui with hot reload, proxies /api to :7070
cd web && npm i && npm run dev
```

Or everything in one container next to your app:

```sh
docker compose -f deploy/docker-compose.yml up --build
# open http://127.0.0.1:7070
```

Send lines over HTTP without Docker:

```sh
curl -X POST localhost:7070/ingest/ndjson -H 'X-Quiet-Source: api' \
  --data-binary $'{"level":30,"msg":"hello","request_id":"req_1"}\nplain text works too'
```

### Config

| Env | Default | |
|---|---|---|
| `QUIET_ADDR` | `127.0.0.1:7070` | Loopback until accounts land (slice 5). |
| `QUIET_DOCKER` | on | `0` to disable the Docker receiver. |
| `QUIET_RING` | `10000` | Live lines kept in memory per source. |
| `QUIET_WEB_DIR` | `web/dist` | Built UI to serve. |

### Docker labels

Sources are named by `com.docker.swarm.service.name` → `com.docker.compose.service` → container name, so replicas merge into one source. Override with `quiet.source=<name>`, skip a container with `quiet.ignore=true`.

## How a line is read

- JSON first; anything else is kept as raw text (level sniffed from `ERROR`/`WARN`/…).
- Timestamp: `timestamp` / `time` / `ts` / `@timestamp` (ISO preferred, epoch s/ms/µs/ns ok), else Docker's timestamp, else arrival. Duplicate keys are tolerated and flagged.
- Level: pino numbers (10–60) or names.
- Every correlation id on the line is indexed (up to 4 levels deep, so a job's `data.request_id` counts). The row shows one by priority `request_id → job_id → trace_id → correlation_id`.

## API (slice 1)

- `GET /api/health` · `GET /api/sources` · `GET /api/sources/:name/lines?limit=`
- `WS /api/stream?source=&backlog=&level=&q=` → frames `backlog`, `lines` (batched every 75 ms), `gap` (client fell behind)
- `POST /ingest/ndjson` with `X-Quiet-Source`
