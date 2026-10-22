# quiet · local workflow: local → main → prod.
.PHONY: dev server web sample up down logs check check-web check-server types build

COMPOSE := docker compose -f deploy/docker-compose.local.yml

## dev: server (cargo watch if installed) + Vite with hot reload on :5173 (proxies /api, /ingest to :7070)
dev:
	@trap 'kill 0' EXIT INT TERM; \
	$(MAKE) --no-print-directory server & \
	(cd web && npm run dev) & \
	wait

server:
	@cd server && if command -v cargo-watch >/dev/null; then cargo watch -w src -x run; else cargo run; fi

## sample: feed sample-api + sample-worker into a running server over HTTP
sample:
	QUIET_URL=http://127.0.0.1:7070 node deploy/sample/generate.mjs both

## up / down / logs: the local compose stack (quiet built from source + sample generator)
up:
	$(COMPOSE) up --build -d
	@echo "quiet: http://127.0.0.1:7070"

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f quiet

## check: everything CI runs (web first, so the server embeds a fresh UI)
check: check-web check-server

check-web:
	cd web && npm ci && npm run lint && npm run typecheck && npm test && npm run build

check-server:
	cd server && cargo fmt --check && cargo clippy --all-targets -- -D warnings && QUIET_EXPECT_UI=1 cargo test

## types: regenerate web/src/gen from the Rust wire types
types:
	cd server && QUIET_UPDATE_TS=1 cargo test bindings

## build: one release binary with the UI embedded
build:
	cd web && npm run build
	cd server && cargo build --release
