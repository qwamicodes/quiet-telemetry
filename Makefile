# quiet · local workflow: local → main → prod.
.PHONY: dev dev-history server web sample up up-history down logs check check-web check-server types build

COMPOSE := docker compose -f deploy/docker-compose.local.yml
COMPOSE_HISTORY := $(COMPOSE) -f deploy/docker-compose.history.yml

## dev: server (cargo watch if installed) + Vite with hot reload on :5173 (proxies /api, /ingest, /v1 to :7070)
dev:
	@trap 'kill 0' EXIT INT TERM; \
	$(MAKE) --no-print-directory server & \
	(cd web && bun run dev) & \
	wait

# Dev server: ingest open so `make sample` works without a token
# (QUIET_INGEST_AUTH=token make dev to try the token flow). Sign-in stays on:
# create the owner on first visit, or `QUIET_AUTH=off make dev` to skip it.
QUIET_INGEST_AUTH ?= open
export QUIET_INGEST_AUTH

server:
	@cd server && if command -v cargo-watch >/dev/null; then cargo watch -w src -x run; else cargo run; fi

## sample: feed sample-api + sample-worker into a running server over HTTP
sample:
	QUIET_URL=http://127.0.0.1:7070 bun deploy/sample/generate.mjs both

## up / down / logs: the local compose stack (quiet built from source + sample generator)
up:
	$(COMPOSE) up --build -d
	@echo "quiet: http://127.0.0.1:7070"

## up-history: the same stack plus Garage for retained history (quiet connects it as garage-local)
up-history:
	$(COMPOSE_HISTORY) up --build -d
	@echo "quiet: http://127.0.0.1:7070 · retained history in Garage (Settings → Storage)"

## dev-history: `make dev` plus Garage for retained history, sign-in off. Nothing
## is built into an image: only Garage runs in Docker; the server (cargo watch)
## and the UI (Vite, :5173) run on this machine and reload as you edit. Data
## stays in server/data and the garage-data volume. `make down` stops Garage.
GARAGE_ADMIN_TOKEN_LOCAL := $(or $(QUIET_GARAGE_ADMIN_TOKEN),quiet-local-garage-admin)
dev-history:
	$(COMPOSE_HISTORY) up -d garage
	@echo "quiet: http://127.0.0.1:5173 (sign-in off) · retained history in Garage (Settings → Storage)"
	@QUIET_AUTH=off \
	QUIET_GARAGE_ENDPOINT=http://127.0.0.1:3900 \
	QUIET_GARAGE_ADMIN_ENDPOINT=http://127.0.0.1:3903 \
	QUIET_GARAGE_ADMIN_TOKEN=$(GARAGE_ADMIN_TOKEN_LOCAL) \
	QUIET_GARAGE_BUCKET=quiet-history \
	$(MAKE) --no-print-directory dev

down:
	$(COMPOSE_HISTORY) down

logs:
	$(COMPOSE) logs -f quiet

## check: everything CI runs (web first, so the server embeds a fresh UI)
check: check-web check-server

check-web:
	cd web && bun install --frozen-lockfile && bun run lint && bun run typecheck && bun run test && bun run build

check-server:
	cd server && cargo fmt --check && cargo clippy --all-targets -- -D warnings && env -u QUIET_INGEST_AUTH QUIET_EXPECT_UI=1 cargo test

## types: regenerate web/src/gen from the Rust wire types
types:
	cd server && QUIET_UPDATE_TS=1 cargo test bindings

## build: one release binary with the UI embedded
build:
	cd web && bun run build
	cd server && cargo build --release
