# syntax=docker/dockerfile:1
# quiet: one static binary with the web UI embedded. Build: web → server → scratch.

FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM rust:1-alpine AS server
RUN apk add --no-cache musl-dev
WORKDIR /src/server
# Dependencies first so they cache across source changes.
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src
COPY server/ ./
# rust-embed reads ../web/dist at compile time.
COPY --from=web /src/web/dist /src/web/dist
RUN touch src/main.rs src/web.rs && cargo build --release && strip target/release/quiet

FROM scratch
COPY --from=server /src/server/target/release/quiet /quiet
ENV QUIET_ADDR=0.0.0.0:7070
EXPOSE 7070
# Runs as root: reading /var/run/docker.sock needs it (or the docker group's gid).
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["/quiet", "healthcheck"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/quiet"]
CMD ["server"]
