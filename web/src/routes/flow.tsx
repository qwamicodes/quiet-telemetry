import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowLeftIcon,
  BoxesIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  FileDownIcon,
  GitForkIcon,
  ListIcon,
  SearchIcon,
  SettingsIcon,
  WaypointsIcon,
  WorkflowIcon,
} from 'lucide-react'
import { useState } from 'react'
import { ExportDialog } from '@/components/export-dialog'
import { type DiagramMode, FieldCard } from '@/components/field-card'
import { FlowGraph } from '@/components/flow/flow-graph'
import { Timeline } from '@/components/flow/timeline'
import { LevelBadge } from '@/components/level-badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { Flow, FlowNotFound, LogLine } from '@/gen'
import { fetchJson, useHealth, useSources } from '@/lib/api'
import { kindLabel } from '@/lib/connect'
import { flowTone, fmtDuration, statusLabel, stitchedBy } from '@/lib/flow'
import { type FlowTarget, useFlow } from '@/lib/flow-api'
import { fmtBytes, fmtClock, fmtDay, fmtTime, fmtWindow, publicHost } from '@/lib/format'
import { searchResponse } from '@/lib/schemas'
import { toast } from '@/lib/toast'
import { useHotkeys } from '@/lib/use-hotkeys'
import { cn } from '@/lib/utils'

const flowRoute = getRouteApi('/flow/$id')
const lineRoute = getRouteApi('/line/$lineId')

/** `/flow/$id`: every line sharing this id, stitched across ids. */
export function FlowPage() {
  const { id } = flowRoute.useParams()
  const { line, card } = flowRoute.useSearch()
  return <FlowScreen target={{ id }} selectedLine={line} view={card} />
}

/** `/line/$lineId`: the flow of one line (a one-node flow when it has no ids). */
export function LineFlowPage() {
  const { lineId } = lineRoute.useParams()
  const { line, card } = lineRoute.useSearch()
  return <FlowScreen target={{ line: lineId }} selectedLine={line ?? lineId} view={card} />
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`Copied ${what}`)
  } catch {
    toast.error('Clipboard is not available here')
  }
}

function Crumbs({
  source,
  label,
  value,
  actions,
}: {
  source?: string
  label?: string
  value: string
  actions?: React.ReactNode
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 font-mono text-[13px]">
      <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/" search={{ source }} />}>
        <ArrowLeftIcon />
        Stream
      </Button>
      {source && (
        <>
          <span className="text-muted-foreground">/</span>
          <span className="text-muted-foreground">{source}</span>
        </>
      )}
      <span className="text-muted-foreground">/</span>
      <span>
        {label && <span className="text-muted-foreground">{label} </span>}
        {value}
      </span>
      <Button variant="ghost" size="icon-xs" aria-label="Copy id" onClick={() => copy(value, label ?? 'id')}>
        <CopyIcon />
      </Button>
      <span className="flex-1" />
      {actions}
    </header>
  )
}

function FlowScreen({ target, selectedLine, view }: { target: FlowTarget; selectedLine?: number; view?: 'diagram' }) {
  const res = useFlow(target)
  const label = 'id' in target ? target.id : `line ${target.line}`
  if (res.isPending)
    return (
      <div className="flex flex-1 flex-col gap-3 px-6 pb-4">
        <Crumbs value={label} />
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-28" />
        <Skeleton className="flex-1" />
      </div>
    )
  if (res.isError)
    return (
      <div className="flex flex-1 flex-col px-6">
        <Crumbs value={label} />
        <p role="alert" className="border border-status-err/30 bg-status-err/10 p-3 text-status-err">
          {res.error.message}
        </p>
      </div>
    )
  if (!res.data.found) return <NotFound nf={res.data} />
  return (
    <FlowView
      flow={res.data.flow}
      since={res.data.since}
      until={res.data.until}
      selectedLine={selectedLine}
      view={view}
    />
  )
}

function FlowView({
  flow,
  since,
  until,
  selectedLine,
  view,
}: {
  flow: Flow
  since: number
  until: number
  selectedLine?: number
  view?: 'diagram'
}) {
  const navigate = useNavigate()
  const first = flow.lines[0]
  const opened = flow.opened ?? first.display_id
  // The breadcrumb's source: where the opened id was logged first.
  const home = flow.lines.find((l) => opened && l.ids.some((i) => i.value === opened.value)) ?? first
  const fallback = flow.nodes.find((n) => n.error) ?? flow.nodes[0]
  const index = Math.max(
    0,
    flow.nodes.findIndex((n) => n.line_id === (selectedLine ?? fallback.line_id)),
  )
  const node = flow.nodes[index]
  const line = flow.lines.find((l) => l.id === node.line_id) as LogLine
  const select = (lineId: number) =>
    navigate({ to: '.', search: (s: Record<string, unknown>) => ({ ...s, line: lineId }), replace: true })
  const move = (by: number) => {
    const next = flow.nodes[Math.min(flow.nodes.length - 1, Math.max(0, index + by))]
    select(next.line_id)
  }
  const [exporting, setExporting] = useState(false)
  // Diagram grows the card over the flow column (04.8) and stays on while
  // J / K move between steps; the URL keeps it so a reload (or Stream's `D`)
  // opens straight on the diagram.
  const [diagram, setDiagramState] = useState<DiagramMode>(view === 'diagram' ? 'wide' : 'off')
  const setDiagram = (m: DiagramMode) => {
    setDiagramState(m)
    if ((m === 'off') !== (diagram === 'off'))
      navigate({
        to: '.',
        search: (s: Record<string, unknown>) => ({ ...s, card: m === 'off' ? undefined : ('diagram' as const) }),
        replace: true,
      })
  }
  const wide = diagram !== 'off'
  const streamSearch = { source: home.source, q: opened?.value }
  const openInStream = () => navigate({ to: '/', search: streamSearch })
  // Flow + card keys (design 08.2): J/K step, O open in stream, Esc back to the stream.
  // The card itself owns C/F/1-3; a dialog on top owns Esc.
  useHotkeys({
    j: () => !exporting && move(1),
    k: () => !exporting && move(-1),
    o: () => !exporting && openInStream(),
    // With the diagram open its own Esc (capture phase) shrinks it back first.
    escape: () => !exporting && !wide && navigate({ to: '/', search: { source: home.source } }),
  })

  const one = flow.line_count === 1
  const tone = flowTone(flow)
  const meta = [
    `${flow.steps} ${flow.steps === 1 ? 'step' : 'steps'}`,
    !one && `${flow.line_count} lines`,
    flow.sources.length > 1 && `${flow.sources.length} sources`,
    fmtDuration(flow.duration_ms),
    `started ${fmtTime(flow.started)}`,
    flow.stitched_by.length > 0 && `stitched by ${stitchedBy(flow)}`,
    flow.span_tree && 'span tree',
    one && `no other line shares this id in the last ${fmtWindow(until - since)}`,
  ].filter(Boolean)

  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 pb-4">
      <Crumbs
        source={home.source}
        label={opened?.key}
        value={opened?.value ?? `line ${first.id}`}
        actions={
          <>
            {flow.ids.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setExporting(true)}>
                <FileDownIcon />
                Export flow
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                copy(
                  JSON.stringify(
                    flow.lines.map((l) => l.fields ?? { raw: l.raw }),
                    null,
                    2,
                  ),
                  'flow JSON',
                )
              }
            >
              <CopyIcon />
              Copy flow JSON
            </Button>
            <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/" search={streamSearch} />}>
              <ListIcon />
              Open in stream
            </Button>
          </>
        }
      />
      <div className="flex items-center gap-3">
        <h1 className="truncate font-medium font-mono text-2xl">{flow.title}</h1>
        <span
          className={cn(
            'shrink-0 border px-1.5 py-0.5 font-mono text-[11px]',
            tone === 'err' && 'border-status-err/40 bg-status-err/10 text-status-err',
            tone === 'warn' && 'border-status-warn/40 bg-status-warn/10 text-status-warn',
            tone === 'ok' && 'border-status-ok/40 bg-status-ok/10 text-status-ok',
          )}
        >
          {one ? `${statusLabel(flow, first).replace(/ · ok$/, '')} · 1 line` : statusLabel(flow, first)}
        </span>
      </div>
      <p className="mt-1 mb-4 font-mono text-muted-foreground text-xs">
        {meta.join(' · ')}
        {flow.truncated && <span className="text-status-warn"> · cut at the flow size limit</span>}
        {flow.partial && <span className="text-status-warn"> · partial: earlier lines may have expired</span>}
      </p>

      {one ? (
        <div className="flex min-h-0 flex-1 gap-6">
          <FieldCard
            line={line}
            className={cn('w-auto flex-1', !wide && 'max-w-3xl')}
            onOpenInStream={openInStream}
            diagram={diagram}
            onDiagramChange={setDiagram}
          />
          {!wide && <OneNodeAside line={line} since={since} until={until} />}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-4">
          <div className={cn('flex min-w-0 flex-1 flex-col gap-3', wide && 'hidden')}>
            <Timeline flow={flow} />
            <FlowGraph flow={flow} selected={node.line_id} onSelect={select} />
            {flow.missing_parent && (
              <p className="font-mono text-muted-foreground text-xs">
                started by {flow.missing_parent.key} {flow.missing_parent.value} · its request line isn't in the window
                ·{' '}
                <Link
                  to="/search"
                  search={{ q: `id:${flow.missing_parent.value}`, range: '7d' }}
                  className="text-brand hover:underline"
                >
                  search
                </Link>
              </p>
            )}
          </div>
          <FieldCard
            key={line.id}
            line={line}
            position={{ index, total: flow.nodes.length }}
            onPrev={() => move(-1)}
            onNext={() => move(1)}
            subtitle={node.attempt != null ? `attempt ${node.attempt}` : undefined}
            title={node.name}
            diagram={diagram}
            onDiagramChange={setDiagram}
            className={cn(wide && 'w-auto flex-1')}
          />
        </div>
      )}
      {exporting && (
        <ExportDialog
          open={exporting}
          onOpenChange={setExporting}
          title="Export flow"
          description={`Every line stitched into this flow${flow.sources.length > 1 ? `, from ${flow.sources.length === 2 ? 'both' : `all ${flow.sources.length}`} sources` : ''}, in time order.`}
          params={{ id: flow.ids.map((i) => i.value).join(',') || undefined, since: flow.started, until: flow.ended }}
          fixedRange={`${fmtTime(flow.started)} - ${fmtTime(flow.ended)} · whole flow`}
          fileName={`quiet-flow-${(opened?.value ?? `line-${first.id}`).replace(/[^A-Za-z0-9_-]/g, '-')}`}
          defaultGzip={false}
          summary={
            <>
              <div className="flex min-h-7 items-center gap-3 border-border/60 border-b py-1">
                <span className="w-24 shrink-0 font-mono text-muted-foreground text-xs">flow</span>
                <span className="truncate font-mono text-xs">
                  {flow.ids.map((i, n) => (
                    <span key={`${i.key}:${i.value}`}>
                      {n > 0 && <span className="text-muted-foreground"> → </span>}
                      <span className="text-muted-foreground">{i.key}</span> {i.value}
                    </span>
                  ))}
                </span>
              </div>
              <div className="flex min-h-7 flex-wrap items-center gap-1.5 border-border/60 border-b py-1">
                <span className="w-24 shrink-0 font-mono text-muted-foreground text-xs">sources</span>
                {flow.sources.map((s) => (
                  <span key={s} className="border px-1.5 font-mono text-xs">
                    {s}
                  </span>
                ))}
              </div>
            </>
          }
          footnote={({ bytes }) =>
            `${flow.line_count} ${flow.line_count === 1 ? 'line' : 'lines'} · ${flow.steps} ${flow.steps === 1 ? 'step' : 'steps'}${bytes != null ? ` · ${fmtBytes(bytes)}` : ''}`
          }
        />
      )}
    </div>
  )
}

/** How to get a structured line out of a shipper that logs plain text (board 04.12). */
function shipperHint(source: string): { what: string; flag: string } | null {
  if (/traefik/i.test(source)) return { what: 'switch its access log to JSON', flag: '--accesslog.format=json' }
  if (/nginx/i.test(source)) return { what: 'give it a JSON log_format', flag: "log_format json escape=json '{…}';" }
  if (/caddy/i.test(source)) return { what: 'use the JSON log encoder', flag: 'log { format json }' }
  return null
}

/** A plain-text line: why Diagram and JSON are off, and how to get structured lines. */
function PlainTextNote({ source, kind }: { source: string; kind?: string }) {
  const hint = shipperHint(source)
  return (
    <div className="border border-dashed p-4" data-testid="plain-text-note">
      <h2 className="flex items-center gap-2 font-medium">
        <WaypointsIcon className="size-4 text-muted-foreground" />
        No diagram for plain text
      </h2>
      <p className="mt-2 text-muted-foreground">
        The Diagram and JSON tabs stay visible but disabled, so the card keeps its shape from line to line. Raw shows
        the line as it was sent.
      </p>
      <p className="mt-3 text-muted-foreground">
        {hint
          ? `To get Fields, Diagram and a flow for ${source}, ${hint.what}:`
          : `To get Fields, Diagram and a flow for ${source}, log one JSON object per line (pino, zap, structlog, slog's JSON handler)${kind ? ` or switch the ${kind} shipper to JSON` : ''}.`}
      </p>
      {hint && (
        <div className="mt-2 flex items-center gap-2 border bg-code px-3 py-2 font-mono text-xs">
          <span className="flex-1 truncate">{hint.flag}</span>
          <Button variant="ghost" size="xs" onClick={() => copy(hint.flag, 'flag')}>
            <CopyIcon />
            Copy
          </Button>
        </div>
      )}
    </div>
  )
}

function OneNodeAside({ line, since, until }: { line: LogLine; since: number; until: number }) {
  const all = useSources().data
  const sources = all?.length
  const kind = all?.find((s) => s.name === line.source)?.kind
  const nearby = useQuery({
    queryKey: ['nearby', line.source, line.id],
    queryFn: () =>
      fetchJson(
        `/api/search?source=${encodeURIComponent(line.source)}&since=${line.ts - 120_000}&until=${line.ts + 120_000}&limit=4`,
        searchResponse,
      ),
    select: (r) => r.lines.filter((l) => l.id !== line.id).slice(0, 3),
  })
  const id = line.display_id
  return (
    <aside className="flex w-[480px] shrink-0 flex-col gap-6">
      {!line.fields && (
        <PlainTextNote
          source={line.source}
          kind={kind && kind !== 'docker' && kind !== 'http' ? kindLabel(kind) : undefined}
        />
      )}
      <div className="border border-dashed p-4">
        <h2 className="flex items-center gap-2 font-medium">
          <GitForkIcon className="size-4 text-muted-foreground" />A one-node flow is just the card
        </h2>
        <p className="mt-2 text-muted-foreground">
          {id
            ? `Only this line carries ${id.key} ${id.value}, so there is nothing to stitch. If a worker logged the same id, its steps would appear here as a flow.`
            : 'This line carries no request, job, trace or correlation id, so there is nothing to stitch.'}
        </p>
        <dl className="mt-3 font-mono text-xs">
          {[
            ['checked', 'request_id → job_id → trace_id → correlation_id'],
            ['window', `last ${fmtWindow(until - since)} · all ${sources ?? ''} sources`.replace('  ', ' ')],
            ['matches', '1 line'],
          ].map(([k, v]) => (
            <div key={k} className="grid grid-cols-[96px_1fr] border-border/60 border-b py-1.5">
              <dt className="text-syntax-key">{k}</dt>
              <dd className="text-muted-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      {nearby.data && nearby.data.length > 0 && (
        <div>
          <h3 className="pb-2 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
            Nearby on {line.source}
          </h3>
          <ul className="border">
            {nearby.data.map((l) => (
              <li key={l.id} className="border-border/60 border-b last:border-b-0">
                <Link
                  to="/line/$lineId"
                  params={{ lineId: l.id }}
                  className="flex h-8 items-center gap-3 px-3 font-mono text-xs hover:bg-row-hover"
                >
                  <span className="text-muted-foreground tabular-nums">{fmtTime(l.ts).slice(0, 8)}</span>
                  <LevelBadge level={l.level} />
                  <span className="truncate">{l.msg}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  )
}

const LOOKED_FOR = 'request_id, job_id, trace_id, correlation_id'

function NotFound({ nf }: { nf: FlowNotFound }) {
  const health = useHealth().data
  const retention = health?.retention_ms ?? nf.until - nf.since
  const sources = useSources().data
  const window = fmtWindow(retention || 86_400_000)
  if (nf.close.length === 0) return <Gone nf={nf} window={window} oldest={health?.oldest ?? null} sources={sources} />
  return (
    <div className="flex flex-1 flex-col px-6 pb-4">
      <Crumbs value={nf.id} />
      <div className="flex items-center gap-3">
        <h1 className="font-medium font-mono text-2xl">{nf.id}</h1>
        <span className="border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">not found</span>
      </div>
      <p className="mt-1 font-mono text-muted-foreground text-xs">
        searched {LOOKED_FOR} · all {sources?.length ?? ''} sources · last {window}
      </p>
      <div className="mx-auto mt-24 flex w-full max-w-[460px] flex-col gap-4">
        <div className="flex flex-col items-center gap-3 border border-dashed p-8 text-center">
          <span className="border p-1.5">
            <GitForkIcon className="size-4 text-muted-foreground" />
          </span>
          <h2 className="font-medium">No lines with this id</h2>
          <p className="text-muted-foreground">
            Nothing in the last {window} carries {nf.id}. It may be older than the window, mistyped, or from a source
            that is paused.
          </p>
          <Button nativeButton={false} render={<Link to="/search" search={{ q: nf.id, range: '24h' }} />}>
            <SearchIcon />
            Search all sources
          </Button>
        </div>
        <div>
          <h3 className="pb-2 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
            Close matches
          </h3>
          <ul className="border">
            {nf.close.map((c) => (
              <li key={c.value} className="border-border/60 border-b last:border-b-0">
                <Link
                  to="/flow/$id"
                  params={{ id: c.value }}
                  className="flex h-8 items-center gap-3 px-3 font-mono text-xs hover:bg-row-hover"
                >
                  <span>{c.value}</span>
                  <span className="flex-1" />
                  <span className="truncate text-muted-foreground">
                    {c.msg} · {fmtClock(c.ts)}
                  </span>
                  <ChevronRightIcon className="size-3.5 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <p className="flex items-center gap-2 text-muted-foreground text-xs">
          <ClockIcon className="size-3.5" />
          <span>
            Need older lines? Retention is {window}. Change it in{' '}
            <Link to="/settings/storage" className="text-brand hover:underline">
              Settings → Storage
            </Link>
            .
          </span>
        </p>
      </div>
    </div>
  )
}

/** A flow link with nothing like it left in the window (design 08.6). */
function Gone({
  nf,
  window,
  oldest,
  sources,
}: {
  nf: FlowNotFound
  window: string
  oldest: number | null
  sources: { paused: boolean }[] | undefined
}) {
  const paused = sources?.filter((s) => s.paused).length ?? 0
  const rows: [React.ReactNode, string, string][] = [
    [
      <ClockIcon key="i" />,
      'Searchable window',
      `${window}${oldest ? ` · oldest line ${fmtDay(oldest)}, ${fmtClock(oldest)}` : ''}`,
    ],
    [<SearchIcon key="i" />, 'Looked for', LOOKED_FOR],
    [
      <BoxesIcon key="i" />,
      'Sources searched',
      `all ${sources?.length ?? ''} · ${paused ? `${paused} paused` : 'none paused'}`.replace('  ', ' '),
    ],
  ]
  return (
    <div className="flex flex-1 flex-col justify-center px-[72px] pb-24">
      <div className="flex max-w-[560px] flex-col gap-6">
        <p className="font-mono text-muted-foreground text-sm">404</p>
        <h1 className="font-semibold text-[32px] leading-tight tracking-tight">
          This flow is no longer in the window.
        </h1>
        <p className="text-base text-muted-foreground">
          Flow links only open while their lines are stored. Nothing in the last {window} carries {nf.id}, so it has
          probably expired. It could also be a typo in the link.
        </p>
        <div className="flex h-9 items-center gap-2 border bg-card/40 px-3 font-mono text-[13px]">
          <WorkflowIcon className="size-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">{`${publicHost()}/flow/`}</span>
          <span className="truncate">{nf.id}</span>
          <span className="flex-1" />
          <span className="bg-status-err/15 px-1.5 text-[11px] text-status-err">404</span>
        </div>
        <dl className="border">
          {rows.map(([icon, k, v]) => (
            <div
              key={k}
              className="grid h-9 grid-cols-[180px_1fr] items-center border-border/60 border-b px-3 last:border-b-0"
            >
              <dt className="flex items-center gap-2 text-[13px] [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
                {icon}
                {k}
              </dt>
              <dd className="truncate font-mono text-muted-foreground text-xs">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button nativeButton={false} render={<Link to="/" />}>
            <ArrowLeftIcon />
            Back to stream
          </Button>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link to="/search" search={{ q: nf.id, range: '24h' }} />}
          >
            <SearchIcon />
            Search {window} for {nf.id}
          </Button>
          <Button variant="ghost" nativeButton={false} render={<Link to="/settings/storage" />}>
            <SettingsIcon />
            Storage settings
          </Button>
        </div>
      </div>
    </div>
  )
}
