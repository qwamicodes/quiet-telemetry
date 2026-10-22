# syntax=docker/dockerfile:1
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM rust:1-alpine AS server
RUN apk add --no-cache musl-dev
WORKDIR /server
COPY server/ ./
RUN cargo build --release

FROM alpine:3.20
WORKDIR /app
COPY --from=server /server/target/release/quiet /usr/local/bin/quiet
COPY --from=web /web/dist /app/web/dist
ENV QUIET_ADDR=0.0.0.0:7070 QUIET_WEB_DIR=/app/web/dist
EXPOSE 7070
ENTRYPOINT ["quiet"]
