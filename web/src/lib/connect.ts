import { z } from 'zod'
import type { SourceInfo, SourceKind } from '@/gen'

/** What the Connect screens offer, in the order the designs show them. */
export const CONNECT_KINDS = ['docker', 'vector', 'fluentbit', 'otlp', 'file'] as const
export type ConnectKind = (typeof CONNECT_KINDS)[number]

export const connectSearch = z.object({
  kind: z.enum(CONNECT_KINDS).optional().catch(undefined),
})
export type ConnectSearch = z.infer<typeof connectSearch>

export const KIND_INFO: Record<ConnectKind, { letter: string; title: string; blurb: string }> = {
  docker: { letter: 'D', title: 'Docker', blurb: 'read every container on this host' },
  vector: { letter: 'V', title: 'Vector', blurb: 'add an http sink to vector.toml' },
  fluentbit: { letter: 'F', title: 'Fluent Bit', blurb: 'forward with the http output' },
  otlp: { letter: 'O', title: 'OpenTelemetry', blurb: 'OTLP logs + traces over HTTP' },
  file: { letter: 'S', title: 'File / stdin', blurb: 'curl a file or pipe a process' },
}

/** How a source kind reads in lists (`fluentbit` → `fluent bit`). */
export const kindLabel = (k: SourceKind) => (k === 'fluentbit' ? 'fluent bit' : k)

/** Kinds whose token is bound to the typed source name; the rest name sources from their data. */
export const bindsSource = (k: ConnectKind) => k === 'file'
/** Kinds that ask for a name (the OTel service name, or the source for curl/pipe). */
export const asksName = (k: ConnectKind) => k === 'otlp' || k === 'file'

export type Snippet = { file: string; code: string; note: string }

/** `qi_8d1f…1a77` shown cut down; copies always get the real token. */
export const maskToken = (t: string) => (t.length > 8 ? `${t.slice(0, 3)}••••${t.slice(-4)}` : t)

/**
 * The copy-paste config for a kind, with the server's real URL and the new
 * token. `origin` is where the browser reached quiet (e.g. `https://quiet.legivent.com`).
 */
export function snippets(
  kind: ConnectKind,
  { origin, token, source, version }: { origin: string; token: string; source: string; version: string },
): Snippet[] {
  const url = new URL(origin)
  const base = origin.replace(/\/$/, '')
  const https = url.protocol === 'https:'
  const port = url.port || (https ? '443' : '80')
  switch (kind) {
    case 'docker':
      return [
        {
          file: 'compose.yaml',
          code: [
            'services:',
            '  quiet:',
            `    image: ghcr.io/qwamicodes/quiet-telemetry:${version}`,
            '    volumes:',
            '      - /var/run/docker.sock:/var/run/docker.sock:ro',
            '      - quiet-data:/data',
            'volumes:',
            '  quiet-data:',
          ].join('\n'),
          note: 'Then docker compose up -d quiet. Using docker run? Add the same socket flag. No token needed: every container becomes a source, named after its swarm or compose service.',
        },
      ]
    case 'vector':
      return [
        {
          file: 'vector.toml',
          code: [
            '[sinks.quiet]',
            'type = "http"',
            'inputs = ["docker_logs"]  # your source ids',
            `uri = "${base}/ingest/vector"`,
            'encoding.codec = "json"',
            'framing.method = "newline_delimited"',
            'compression = "gzip"',
            'auth.strategy = "bearer"',
            `auth.token = "${token}"`,
          ].join('\n'),
          note: 'Each event lands in the source named by its `source` field, else `service`, else `container_name`. Set one in a remap transform to rename. JSON app lines inside `message` are unwrapped.',
        },
      ]
    case 'fluentbit':
      return [
        {
          file: 'fluent-bit.conf',
          code: [
            '[OUTPUT]',
            '    Name             http',
            '    Match            *',
            `    Host             ${url.hostname}`,
            `    Port             ${port}`,
            '    URI              /ingest/fluentbit',
            '    Format           json_lines',
            '    Json_date_key    date',
            '    Json_date_format epoch',
            '    Header_tag       X-Quiet-Tag',
            `    Header           Authorization Bearer ${token}`,
            '    Compress         gzip',
            ...(https ? ['    tls              On'] : []),
          ].join('\n'),
          note: 'Each Fluent Bit tag becomes a source, e.g. legivent.api → legivent-api. JSON app lines inside `log` are unwrapped.',
        },
      ]
    case 'otlp':
      return [
        {
          file: '.env (SDK)',
          code: [
            `OTEL_EXPORTER_OTLP_ENDPOINT=${base}`,
            'OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf',
            `OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer ${token}"`,
            `OTEL_SERVICE_NAME=${source}`,
          ].join('\n'),
          note: 'service.name becomes the source. Logs go to /v1/logs; traces to /v1/traces show as a span tree in the flow. HTTP now, gRPC later.',
        },
        {
          file: 'otel-collector.yaml',
          code: [
            'exporters:',
            '  otlphttp/quiet:',
            `    endpoint: ${base}`,
            '    headers:',
            `      authorization: Bearer ${token}`,
            'service:',
            '  pipelines:',
            '    logs: { receivers: [otlp], exporters: [otlphttp/quiet] }',
            '    traces: { receivers: [otlp], exporters: [otlphttp/quiet] }',
          ].join('\n'),
          note: 'Already run a Collector? Add quiet as one more exporter. service.name becomes the source.',
        },
      ]
    case 'file':
      return [
        {
          file: 'shell',
          code: [
            '# send a file: one JSON object or text line per row',
            `curl -X POST ${base}/ingest/ndjson \\`,
            `  -H 'Authorization: Bearer ${token}' \\`,
            `  -H 'X-Quiet-Source: ${source}' \\`,
            '  --data-binary @app.log',
            '',
            '# or pipe a process (the quiet binary on this machine, plain http)',
            `bun run start | quiet pipe --name ${source} --url ${base} --token ${token}`,
          ].join('\n'),
          note: `This token only sends to ${source}. Non-JSON lines are kept as raw text, never dropped.`,
        },
      ]
  }
}

/** Replace the token in a snippet with its masked form (for showing it on screen). */
export const maskIn = (code: string, token: string) => (token ? code.split(token).join(maskToken(token)) : code)

/** Which source kind each connect kind shows up as. */
const RECEIVER: Record<ConnectKind, SourceKind> = {
  docker: 'docker',
  vector: 'vector',
  fluentbit: 'fluentbit',
  otlp: 'otlp',
  file: 'http',
}

/**
 * The source that just sent lines since `baseline` (line counts when waiting
 * began): the one named `name` first, else (unless the token is bound to
 * that name) any source of this kind.
 */
export function firstArrival(
  kind: ConnectKind,
  sources: SourceInfo[],
  baseline: Record<string, number>,
  name?: string,
): SourceInfo | null {
  const grew = sources.filter((s) => s.lines > (baseline[s.name] ?? 0))
  const named = name ? grew.find((s) => s.name === name) : undefined
  if (named) return named
  if (bindsSource(kind)) return null
  return grew.find((s) => s.kind === RECEIVER[kind]) ?? null
}
