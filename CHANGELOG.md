# Changelog

## 0.1.0 (unreleased)

The first version: one host, one binary, a calm live view of canonical logs.

- **Ingest.** Docker containers from the local socket (named by swarm service → compose service → container, replicas merged; finds Docker Desktop, OrbStack, Colima, rootless sockets and the current `docker context`). HTTP pushes from Vector, Fluent Bit, OTLP/HTTP logs + traces, NDJSON/curl and `quiet pipe`, with send-only `qi_` ingest tokens, body and rate limits.
- **Stream.** One source at a time over a WebSocket, newest at the bottom (or top), level toggles and text filter, keyboard navigation, field card, reconnect with backoff.
- **Storage.** SQLite (WAL) hourly partitions with FTS5 and an index of every correlation id; 24h window by default (1h–7d), a disk cap that drops the oldest hour first, purge, per-source windows.
- **Flows.** Every line sharing an id, stitched across sources (request → job → retries, two hops, bounded), OTLP span trees, step graph + timeline, child steps from `wideEvents`.
- **Search & export.** Words, phrases, `level:`, `source:`, `id:`, `key:value` filters, histogram, group by flow; NDJSON / JSON / CSV export with PII masking and a 15-minute read-only `qx_` Copy-curl token; very large exports are prepared on the server with progress, Cancel and an "Export ready" toast.
- **Accounts.** First-run owner, members via copy-link invites, argon2id passwords, cookie sessions with CSRF, reset links and `quiet admin reset-password`.
- **Settings.** General (instance name, timezone, stream direction), Flow id order (keys, order, match by key or value), Storage (usage, partitions, volume by source, projection, window, cap, purge), per-source settings (display name, hide, pause ingest, window, id keys, default level, PII masking, muted lines, purge, remove that also revokes its bound tokens with Undo) with a Rejected tab; UI values override the CLI/env defaults.
- **System.** `/api/system` and app banners for Docker unavailable, disk near/at the cap, a nearly full data volume, store write errors and refused ingest requests. In-memory live lines are capped by a shared memory budget (`QUIET_RING_MEMORY`, 64MB).
