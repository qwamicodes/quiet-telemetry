# Ingest

Docker needs nothing: quiet reads every container's stdout/stderr through the local socket (see [Docker labels](configuration.md#docker-labels)). Everything else pushes over HTTP with an **ingest token**.

## Ingest tokens

- A token is `qi_…` and **send-only**: it can push lines, nothing else. Read-only `qx_` export tokens are separate.
- Create one in **Settings → Ingest tokens**, or let **Connect a source** make one and fill it into the config for you.
- Only its SHA-256 is stored, so the token is shown once.
- A token is bound to one source (every line it sends lands there) or to all sources (the shipper names them).
- Revoking takes effect on the next request; Undo restores it within 60 seconds. Last used is shown per token.

## Endpoints

| Endpoint | For | Source name (unless the token is bound) |
|---|---|---|
| `POST /ingest/vector` | Vector `http` sink, `encoding.codec = "json"` (NDJSON or one array) | `X-Quiet-Source`, else the event's `source` / `service` / `container_name`, else `vector` |
| `POST /ingest/fluentbit` (also `/ingest/fluent-bit`) | Fluent Bit `http` output, `Format json_lines` (or `json`, `json_stream`) | `X-Quiet-Source`, else the tag (`Header_tag X-Quiet-Tag`; `legivent.api` → `legivent-api`), else the record's `source` / `service` / `container_name`, else `fluent-bit` |
| `POST /v1/logs`, `POST /v1/traces` | OTLP/HTTP, `application/x-protobuf` or JSON | `X-Quiet-Source`, else the resource's `service.name`, else `otlp` |
| `POST /ingest/ndjson` | curl, `quiet pipe`, anything: one JSON object or text line per row | `X-Quiet-Source`, else `http` |

- **Shipper envelopes.** Shippers wrap the app's line (`{"message": "<line>", "container_name": …}` from Vector's `docker_logs`, `{"log": "<line>", "date": …}` from Fluent Bit). quiet stores the app's own line when the message is a JSON object, or when everything around it is collector metadata, so its ids stitch flows; the shipper's time becomes the collector timestamp. Events with their own fields are kept whole.
- **OTLP.** Log records become `{ timestamp, level, msg, service, trace_id, span_id, …attributes, …body fields, resource, scope }`. Spans become `{ timestamp (end), level (error when the status is ERROR), name, otel.type: "span", span.kind, duration_ms, trace_id, span_id, parent_span_id, otel.status_code, …attributes, steps (events) }`. OTLP/gRPC is not supported yet.
- **Limits.** Bodies may be gzip (or deflate). `QUIET_INGEST_MAX_BODY` (413) and `QUIET_INGEST_RATE` per token (429 + `Retry-After`; a limited batch is not stored, so the shipper's retry resends it whole).
- **Refusals.** A missing, unknown or revoked token gets 401 with the reason. Rejected requests are logged and listed on the source's **Rejected** tab; their bodies are not kept.
- **Redaction.** Every line is sanitized before it is stored (see [Redaction before storage](how-it-works.md#redaction-before-storage)).
- **Remote shippers.** The binary listens on `127.0.0.1:7070` by default. Shippers on other machines need `QUIET_ADDR=0.0.0.0:7070` (the image already uses it; publish the port or route it through your proxy). Ingest is gated by `qi_` tokens and the UI and `/api` by sign-in, so exposing quiet is fine; use TLS (a reverse proxy) so tokens and passwords never cross the network in clear text.

## Shipper configs

Vector (`vector.toml`):

```toml
[sinks.quiet]
type = "http"
inputs = ["docker_logs"]
uri = "https://quiet.example.com/ingest/vector"
encoding.codec = "json"
framing.method = "newline_delimited"
compression = "gzip"
auth.strategy = "bearer"
auth.token = "qi_…"
```

Fluent Bit (`fluent-bit.conf`):

```ini
[OUTPUT]
    Name             http
    Match            *
    Host             quiet.example.com
    Port             443
    URI              /ingest/fluentbit
    Format           json_lines
    Json_date_key    date
    Json_date_format epoch
    Header_tag       X-Quiet-Tag
    Header           Authorization Bearer qi_…
    Compress         gzip
    tls              On
```

OpenTelemetry SDK (env) or Collector:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=https://quiet.example.com
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer qi_…"
OTEL_SERVICE_NAME=payments-svc
```

```yaml
exporters:
  otlphttp/quiet:
    endpoint: https://quiet.example.com
    headers: { authorization: Bearer qi_… }
service:
  pipelines:
    logs: { receivers: [otlp], exporters: [otlphttp/quiet] }
    traces: { receivers: [otlp], exporters: [otlphttp/quiet] }
```

curl, a file, or a process:

```sh
curl -X POST https://quiet.example.com/ingest/ndjson -H 'Authorization: Bearer qi_…' \
  -H 'X-Quiet-Source: cron-runner' --data-binary @app.log
bun run start | quiet pipe --name my-api --token qi_…   # plain http only; echoes stdin
```
