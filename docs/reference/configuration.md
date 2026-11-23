# Configuration

Every flag also reads its env var (`quiet --help`). `quiet` with no subcommand is `quiet server`. Several values can also be changed in the UI; see [Settings precedence](how-it-works.md#settings).

## Server flags

| Flag / Env | Default | |
|---|---|---|
| `--addr` / `QUIET_ADDR` | `127.0.0.1:7070` | The image uses `0.0.0.0:7070`. Everything except `/health`, `/ready` and token-gated ingest needs a signed-in session, so listening on all interfaces is fine; put TLS in front (a reverse proxy) for anything beyond your machine. |
| `--auth` / `QUIET_AUTH` | `on` | `on`: accounts and sign-in. `off`: no sign-in, every request acts as a local owner, for local development only; the server refuses to start with `off` unless `--addr` is a loopback address. |
| `--cookie-secure` / `QUIET_COOKIE_SECURE` | `auto` | `Secure` flag on the session cookie. `auto`: set when the proxy says the request came over https (`X-Forwarded-Proto: https`). `on` / `off` force it. |
| `--trust-proxy` / `QUIET_TRUST_PROXY` | `off` | Take the client address from `X-Forwarded-For` (rightmost hop) / `X-Real-IP`, for sign-in backoff and the sessions list. Turn on only when a reverse proxy you run sets those headers and quiet isn't reachable around it. |
| `--docker` / `QUIET_DOCKER` | `on` | `0`/`off` disables the Docker receiver. |
| `--ring` / `QUIET_RING` | `10000` | Live lines kept in memory per source (the stream backlog). |
| `--ring-memory` / `QUIET_RING_MEMORY` | `64MB` | Memory for those lines, every source together (estimated: raw line + parsed fields). Split evenly between sources; a source over its share drops its oldest live lines (stored lines are unaffected). Keeps quiet inside the prod compose's 256MB limit. |
| `--store` / `QUIET_STORE` | `sqlite` | `sqlite`: the searchable window on disk. `memory`: the live ring only, nothing survives a restart, search covers the ring. |
| `--data-dir` / `QUIET_DATA_DIR` | `data` (image: `/data`) | Where `quiet.db` (+ `-wal`) lives. **Mount a volume here** (`deploy/docker-compose.*.yml` do). |
| `--retention` / `QUIET_RETENTION` | `24h` | How long lines stay searchable, `1h` … `7d` (e.g. `3d`, `7d`). Whole hours are dropped, so a line can outlive it by up to an hour. **A value saved in Settings → Storage wins over this flag.** |
| `--max-disk` / `QUIET_MAX_DISK` | `5GB` | Disk cap for the database (`500MB`, `5GB`, `1GiB`; min 10MB). Over it, the oldest hour goes first. Whichever of retention and cap hits first wins. **A value saved in Settings → Storage wins over this flag.** |
| `--group-by` / `QUIET_GROUP_BY` | unset (`auto`) | How sources group in the UI: `auto` (a `quiet.group` label, then the Compose project, then the Swarm stack, else Standalone), `label` (by `QUIET_GROUP_LABEL`) or `off`. **When set it wins over Settings → General and locks that control.** |
| `--group-label` / `QUIET_GROUP_LABEL` | unset (`quiet.group`) | The Docker label `label` mode reads. Containers without it are Standalone. Also locks the control when set. |
| `--search-include-muted` / `QUIET_SEARCH_INCLUDE_MUTED` | unset (`off`) | `on` shows muted lines in search results (dimmed, tagged `muted`) for sources that don't decide for themselves. **A value saved in Settings → General wins over this flag.** The stream always hides them. |
| `--web-dir` / `QUIET_WEB_DIR` | embedded | Serve the UI from a directory instead of the copy built into the binary. |
| `--drain-ms` / `QUIET_DRAIN_MS` | `1000` | On SIGTERM, how long `/ready` is 503 before connections close. |
| `--shutdown-timeout-ms` / `QUIET_SHUTDOWN_TIMEOUT_MS` | `10000` | Hard limit for a graceful stop. |
| `--ingest-auth` / `QUIET_INGEST_AUTH` | `token` | `token`: every HTTP ingest request needs a `qi_` ingest token. `open`: tokenless requests are accepted too (local development; `make dev` and the local compose use it). A token that is sent is always checked. |
| `--ingest-max-body` / `QUIET_INGEST_MAX_BODY` | `16MB` | Largest ingest body, checked before and after gzip (1KB … 1GB). Over it: 413. |
| `--ingest-rate` / `QUIET_INGEST_RATE` | `20000` | Lines per second per ingest token, bursts of 5 s worth; `0` = unlimited. Over it: 429 + `Retry-After`. |

## Other subcommands

- `quiet pipe --name <source> [--url http://127.0.0.1:7070] [--token qi_…] [--silent]` sends stdin to a server as NDJSON (plain http only; env `QUIET_SOURCE`, `QUIET_URL`, `QUIET_TOKEN`). It echoes stdin to stdout unless `--silent`. See [Ingest](ingest.md).
- `quiet admin reset-password <email> [--data-dir data] [--url https://quiet.example.com]` prints a one-time reset link, valid for an hour (env `QUIET_DATA_DIR`, `QUIET_PUBLIC_URL`). See [Accounts](accounts.md).
- `quiet agent` is a placeholder and exits non-zero until the remote agent ships.
- `quiet healthcheck` (hidden) exits 0 when the local server answers `/ready`; the image's healthcheck uses it.

## Docker labels

Every container is its own source, keyed by what survives a redeploy: the Swarm service name (`<stack>_<svc>`, plus `.<slot>` for replicas after the first), else `<compose project>.<service>` (plus `.<n>` after container 1), else the container name. Two `postgres` services in different projects or environments are two sources. The UI shows the service name, and adds the project or stack (`api · shop-prod`) only when another source would show the same name.

| Label | Effect |
|---|---|
| `quiet.source=<name>` | Choose the source name. Give several containers the same one to merge them on purpose. |
| `quiet.ignore=true` | Skip the container. |
| `quiet.group=<name>` | Put the source in that group in `auto` grouping (or the label named by `QUIET_GROUP_LABEL` in `label` mode). |

```yaml
# in your app's compose file
services:
  my-api:
    labels:
      quiet.source: my-api      # rename the source
  redis:
    labels:
      quiet.ignore: "true"      # hide noisy containers
```

Upgrading from a version that named sources by the bare service: on the first start, an old source with one running container keeps its name, lines and settings; an old source that had merged several containers keeps its lines (labelled "merged, before the split") until they age out, and each container gets its own source that inherits the old one's settings (not its display name) and custom group.
