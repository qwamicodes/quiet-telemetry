# Development

How to run quiet from source, work on it and ship a change. For contributing rules (branches, PRs, CHANGELOG) see [CONTRIBUTING.md](../CONTRIBUTING.md).

## 1. Install the tools (once)

| Tool | Why | Install | Check |
|---|---|---|---|
| Docker Desktop (macOS) or Docker Engine + Compose v2 (Linux) | runs quiet and reads container logs | https://docs.docker.com/get-docker/ | `docker compose version` |
| Git | clone the repo | already on most machines | `git --version` |
| Bun 1.4+ | the web UI and the sample generator (only for `make dev` / `make check` / `make sample`) | `curl -fsSL https://bun.sh/install \| bash` | `bun -v` |
| Rust stable | the server (only for `make dev` / `make check`) | `curl https://sh.rustup.rs -sSf \| sh` | `cargo -V` |
| make | the shortcuts below | macOS: `xcode-select --install` | `make -v` |
| cargo-watch (optional) | restarts the server when you save | `cargo install cargo-watch` | |

Only want to try it? Docker + Git + make is enough (path A).

## 2. Get the code

```sh
git clone https://github.com/qwamicodes/quiet-telemetry.git   # or your fork
cd quiet-telemetry
```

## 3A. Run everything in Docker (easiest)

```sh
make up      # builds quiet from source + starts a sample log generator
```

Open http://127.0.0.1:7070. The first build takes a few minutes (Rust); later ones are cached.

The first visit asks you to **set up quiet**: your name, email and a password (12+ characters). That account is the owner. After that, quiet always asks you to sign in (see [Accounts](reference/accounts.md)).

What you should see:

- Sources on the left: `sample-api`, `sample-worker`, plus every other container running on your machine.
- Pick `sample-api`: new events arrive every second, newest at the bottom. Each row reads `flow · METHOD path → status_code`, with the reason when it failed.
- Click a row: a preview opens under it. Press **Enter** to open it as a flow: the API request, the `sample-worker` job it enqueued (same `request_id`) and the job's attempts, as an activity list with the field card of the selected event beside it. **Timing** shows the timeline and graph.
- **Search** (sidebar): try `payout level:>=warn`, click a `request_id` value to narrow, switch *Group by flow* / *Events*, then **Export** (CSV, gzip, Copy curl).
- Restart (`make down && make up`): the sources, ids and search history are still there (the `quiet-data` volume).

Useful while it runs:

```sh
make logs    # quiet's own logs
make down    # stop and remove the stack
```

## 3B. Run it for development (hot reload)

```sh
(cd web && bun install)   # once, and after package.json changes
make dev              # server on :7070 + UI on :5173 with hot reload
make sample           # second terminal: sample events over HTTP
```

Open http://127.0.0.1:5173 (Vite proxies `/api`, `/ingest` and `/v1` to the server) and create the owner account the first time (it lives in `server/data/quiet.db`).

- `make dev` runs with `QUIET_INGEST_AUTH=open` so `make sample` needs no token; `QUIET_INGEST_AUTH=token make dev` tries the token flow.
- Working on something unrelated to accounts? `QUIET_AUTH=off make dev` skips sign-in entirely (loopback only; see [Accounts](reference/accounts.md)).
- Edit `web/src/**` and the page updates; edit `server/src/**` and the server restarts (with cargo-watch) or re-run `make dev`.
- The server also reads your local Docker socket here, so your running containers show up too. Turn that off with `QUIET_DOCKER=off make dev`.
- The server on :7070 serves the UI embedded at build time. After a web change, `cd web && bun run build` (or use :5173).

## 4. Before you push

```sh
make check   # exactly what CI runs: web lint/typecheck/test/build, cargo fmt/clippy/test
make types   # only if you changed a Rust type the UI uses (regenerates web/src/gen)
make build   # optional: one release binary at server/target/release/quiet with the UI inside
```

`make check` unsets `QUIET_INGEST_AUTH` for the server tests, so the `make dev` default doesn't leak into them.

## Troubleshooting

| Problem | Fix |
|---|---|
| No containers in the source list | Docker isn't reachable. Check `docker ps` works. `make dev` finds the engine on its own: `DOCKER_HOST`, then `/var/run/docker.sock`, Docker Desktop (`~/.docker/run/docker.sock`), OrbStack, Colima, Rancher Desktop, rootless Docker, then your current `docker context`. The log line `docker connected endpoint=…` says which one it used. Still stuck: `export DOCKER_HOST=$(docker context inspect -f '{{.Endpoints.docker.Host}}')`. On Linux add yourself to the `docker` group (`sudo usermod -aG docker $USER`, then log out/in). For `make up`, change the socket path in `deploy/docker-compose.local.yml`. |
| `port 7070 is already allocated` / `address in use` | Something else is on 7070: `make down`, or run with `QUIET_ADDR=127.0.0.1:7171 make dev`. |
| UI shows "Reconnecting…" forever | The server isn't running or crashed: check the `make dev` terminal or `make logs`. |
| Blank page at :7070 after `cargo run` | The binary embeds the UI at build time: run `cd web && bun run build` first (or use `make build` / `make dev`). |
| `make check` fails on stale types | Run `make types` and commit `web/src/gen`. |
| `cargo fmt`/`clippy` errors | `cd server && cargo fmt` then fix what clippy prints; CI uses `-D warnings`. |
| First `make up` is slow | Normal: Rust compiles everything once. Later builds reuse the cache. |
| Sample events missing | `make sample` needs the server running first; in Docker, `docker compose -f deploy/docker-compose.local.yml logs sample`. |

## Releases and deploys

`main` is production. There is no staging branch: testing happens locally. Every change goes **local → main → prod**: built and checked locally (`make check`, `make up`), merged to `main` by PR, then deployed once the `production` environment approves it.

- Every push to `main` publishes `ghcr.io/qwamicodes/quiet-telemetry:sha-<sha>` (amd64). A `vX.Y.Z` tag on `main` publishes `:X.Y.Z` for amd64 and arm64. There is no `latest`. The job summary prints the digest.
- The `deploy-production` job waits for approval on the `production` GitHub Environment, then points the Dokploy app at the image **by digest** and deploys. It skips cleanly until the Dokploy secrets exist.
- `deploy/docker-compose.prod.yml` is the reference for running it yourself (digest-pinned, loopback port, healthcheck, memory limit).
- Releases are tagged on `main` and published as GitHub releases with the matching [CHANGELOG](../CHANGELOG.md) section.

Technical decisions per slice: [decisions.md](decisions.md).
