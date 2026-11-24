import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  FileDownIcon,
  GitForkIcon,
  ListIcon,
  SearchIcon,
  WaypointsIcon,
} from 'lucide-react'
import { type CSSProperties, useMemo, useState } from 'react'
import { ExportDialog } from '@/components/export-dialog'
import { type DiagramMode, FieldCard, plainRead } from '@/components/field-card'
import { ActivityList } from '@/components/flow/activity-list'
import { FlowGraph } from '@/components/flow/flow-graph'
import { FlowHistoryNote } from '@/components/flow/history-note'
import { Timeline } from '@/components/flow/timeline'
import { LevelBadge } from '@/components/level-badge'
import { MobileFlow } from '@/components/mobile/mobile-flow'
import { useIsMobile } from '@/components/mobile/use-mobile'
import { INSPECTOR, INSPECTOR_SINGLE, PanelResize, usePanelWidth } from '@/components/panel-resize'
import { SidebarToggle } from '@/components/sidebar-resize'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { Flow, FlowHistory, FlowNotFound, LogLine } from '@/gen'
import { activityCounts, buildActivity, JOB_EVIDENCE, type JobRow, jobBadge } from '@/lib/activity'
import { fetchJson, useHealth, useSources } from '@/lib/api'
import { kindLabel } from '@/lib/connect'
import { flowTone, fmtDuration, statusLabel } from '@/lib/flow'
import { type FlowTarget, useFlow } from '@/lib/flow-api'
import { fmtBytes, fmtClock, fmtTime, fmtWindow } from '@/lib/format'
import { useHistorySearch } from '@/lib/history-search'
import { searchResponse } from '@/lib/schemas'
import { toast } from '@/lib/toast'
import { useHotkeys } from '@/lib/use-hotkeys'
import { cn } from '@/lib/utils'
import { useSeenOnVisit } from '@/lib/whats-new'

const flowRoute = getRouteApi('/flow/$id')
const lineRoute = getRouteApi('/line/$lineId')

/** `/flow/$id`: every line sharing this id, stitched across ids. */
export function FlowPage() {
  useSeenOnVisit('flow')
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
    <header className="flex h-14 shrink-0 items-center gap-3 text-[13px]">
      <SidebarToggle />
      <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/" search={{ source }} />}>
        <ArrowLeftIcon />
        Stream
      </Button>
      {source && (
        <>
          <span className="text-muted-foreground">/</span>
          <span className="font-mono text-muted-foreground">{source}</span>
        </>
      )}
      <span className="text-muted-foreground">/</span>
      <span className="font-mono">
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
      history={res.data.history}
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
  history,
}: {
  flow: Flow
  since: number
  until: number
  /** The flow may continue in retained history not loaded (Phase 5c). */
  history?: FlowHistory
  selectedLine?: number
  view?: 'diagram'
}) {
  const navigate = useNavigate()
  const first = flow.lines[0]
  const opened = flow.opened ?? first.display_id
  // The breadcrumb's source: where the opened id was logged first.
  const home = flow.lines.find((l) => opened && l.ids.some((i) => i.value === opened.value)) ?? first
  // Related events found in retained history join the activity list.
  const historyParams = useMemo(
    () => ({ q: opened ? `id:${opened.value}` : undefined, since: history?.since, until: history?.until }),
    [opened, history?.since, history?.until],
  )
  const fromHistory = useHistorySearch(historyParams, undefined)
  const historyLines = fromHistory.job?.lines
  const allLines = useMemo(
    () =>
      historyLines?.length ? [...historyLines, ...flow.lines].sort((a, b) => a.ts - b.ts || a.id - b.id) : flow.lines,
    [flow.lines, historyLines],
  )
  const activity = useMemo(() => buildActivity(allLines, opened ?? null), [allLines, opened])
  const openedJob = opened?.key === 'job_id' ? activity.main.find((r): r is JobRow => r.kind === 'job') : undefined
  // Opened by a job id: its final attempt (04.2); else the first error, else the first event.
  const lastAttempt = openedJob?.attempts[openedJob.attempts.length - 1]?.line.id
  const fallback = flow.nodes.find((n) => n.line_id === lastAttempt) ?? flow.nodes.find((n) => n.error) ?? flow.nodes[0]
  const index = Math.max(
    0,
    flow.nodes.findIndex((n) => n.line_id === (selectedLine ?? fallback.line_id)),
  )
  const node = flow.nodes[index]
  // A line from retained history has no step node: the card shows it directly.
  const archived = selectedLine != null ? historyLines?.find((l) => l.id === selectedLine) : undefined
  const line = archived ?? (flow.lines.find((l) => l.id === node.line_id) as LogLine)
  const select = (lineId: number) =>
    navigate({ to: '.', search: (s: Record<string, unknown>) => ({ ...s, line: lineId }), replace: true })
  const move = (by: number) => {
    const next = flow.nodes[Math.min(flow.nodes.length - 1, Math.max(0, index + by))]
    select(next.line_id)
  }
  const [exporting, setExporting] = useState(false)
  const mobile = useIsMobile()
  const [cardW, setCardW] = usePanelWidth(INSPECTOR)
  const [singleW, setSingleW] = usePanelWidth(INSPECTOR_SINGLE)
  // Activity is the default (v0.1.1-04.x); Timing shows the timeline and graph.
  const [timing, setTiming] = useState(false)
  // Full screen (04.17): activity + inspector cover the app; Esc exits.
  const [full, setFull] = useState(false)
  // The inspector's × hides it until a row is picked again.
  const [cardOpen, setCardOpen] = useState(true)
  const pick = (lineId: number) => {
    setCardOpen(true)
    select(lineId)
  }
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
    escape: () => {
      if (exporting || wide) return
      if (full) setFull(false)
      else navigate({ to: '/', search: { source: home.source } })
    },
  })

  const one = flow.line_count === 1
  const tone = openedJob ? (openedJob.tone === 'muted' ? 'warn' : openedJob.tone) : flowTone(flow)
  const correlated = flow.stitched_by.length > 0 && `correlated by ${flow.stitched_by[0]}`
  // 04.1: "1 request · 1 job · 2 completion events · correlated by request_id";
  // 04.2: "3 attempts · payouts · terminal failure confirmed by the queue";
  // 04.4: "1 event · 38ms · correlated by request_id · last 24h".
  const meta = (
    one
      ? ['1 event', fmtDuration(flow.duration_ms), correlated, `last ${fmtWindow(until - since)}`]
      : openedJob
        ? [
            `${openedJob.attempts.length} ${openedJob.attempts.length === 1 ? 'attempt' : 'attempts'}`,
            openedJob.queue,
            JOB_EVIDENCE[openedJob.state],
          ]
        : [
            activityCounts(activity, { related: true }),
            `${activity.completions} completion ${activity.completions === 1 ? 'event' : 'events'}`,
            correlated,
            flow.span_tree && 'span tree',
          ]
  ).filter(Boolean)
  const title = openedJob ? openedJob.flow : flow.title
  // 04.13: a single plain-text line reads "404 · plain text" and has no flow actions.
  const plain = one && !first.fields
  const badge = plain
    ? `${plainRead(first).find(([k]) => k === 'status')?.[1] ?? first.level ?? 'line'} · plain text`
    : one
      ? `${statusLabel(flow, first).replace(/ · ok$/, '')} · 1 event`
      : openedJob
        ? jobBadge(openedJob)
        : statusLabel(flow, first)

  const copyFlow = () =>
    copy(
      JSON.stringify(
        flow.lines.map((l) => l.fields ?? { raw: l.raw }),
        null,
        2,
      ),
      'flow JSON',
    )
  // Phone (10.2): stacked steps and the card as a bottom sheet.
  if (mobile)
    return (
      <MobileFlow
        flow={flow}
        title={title}
        badge={badge}
        tone={tone}
        source={home.source}
        index={index}
        onSelect={select}
        onPrev={() => move(-1)}
        onNext={() => move(1)}
        onCopy={copyFlow}
      />
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 pb-4">
      <Crumbs
        source={home.source}
        label={opened?.key}
        value={opened?.value ?? `line ${first.id.toLocaleString('en-US')}`}
        actions={
          <>
            {flow.ids.length > 0 && !plain && (
              <Button variant="outline" size="sm" onClick={() => setExporting(true)}>
                <FileDownIcon />
                Export flow
              </Button>
            )}
            {!plain && (
              <Button variant="outline" size="sm" onClick={copyFlow}>
                <CopyIcon />
                Copy flow JSON
              </Button>
            )}
            <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/" search={streamSearch} />}>
              <ListIcon />
              Open in stream
            </Button>
          </>
        }
      />
      <div className="flex items-center gap-3">
        <h1 className="truncate font-mono font-semibold text-2xl tracking-tight">{title}</h1>
        <span
          className={cn(
            'shrink-0 border px-1.5 py-0.5 font-mono text-[11px]',
            tone === 'err' && 'border-status-err/40 bg-status-err/10 text-status-err',
            tone === 'warn' && 'border-status-warn/40 bg-status-warn/10 text-status-warn',
            tone === 'ok' && 'border-status-ok/40 bg-status-ok/10 text-status-ok',
          )}
        >
          {badge}
        </span>
      </div>
      <p className="mt-1 mb-4 font-mono text-muted-foreground text-xs">
        {meta.join(' · ')}
        {flow.truncated && <span className="text-status-warn"> · cut at the flow size limit</span>}
        {flow.partial && <span className="text-status-warn"> · partial: earlier lines may have expired</span>}
      </p>

      {one ? (
        <div className="flex min-h-0 flex-1 gap-3" style={{ '--card-w': `${singleW}px` } as CSSProperties}>
          <FieldCard
            line={line}
            className={cn(wide ? 'w-auto flex-1' : 'w-[var(--card-w)] max-w-[70%]')}
            onOpenInStream={openInStream}
            diagram={diagram}
            onDiagramChange={setDiagram}
          />
          {!wide && (
            <PanelResize
              label="Resize inspector"
              size={INSPECTOR_SINGLE}
              width={singleW}
              onWidth={(w) => setSingleW(w)}
            />
          )}
          {!wide && <OneNodeAside line={line} since={since} until={until} />}
        </div>
      ) : (
        <div
          className={cn('flex min-h-0 flex-1 gap-1', full && 'fixed inset-0 z-40 bg-background p-4')}
          style={{ '--card-w': `${cardW}px` } as CSSProperties}
        >
          <div className={cn('flex min-w-0 flex-1 flex-col gap-3', wide && 'hidden')}>
            {timing ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[13px]">Timing · {flow.steps} steps</span>
                  <Button variant="outline" size="xs" onClick={() => setTiming(false)}>
                    <ListIcon />
                    Activity
                  </Button>
                </div>
                <Timeline flow={flow} />
                <FlowGraph flow={flow} selected={node.line_id} onSelect={select} />
              </>
            ) : (
              <ActivityList
                lines={allLines}
                opened={opened ?? null}
                selected={node.line_id}
                onSelect={pick}
                timing={timing}
                onTiming={setTiming}
                full={full}
                onFull={() => setFull((f) => !f)}
                window={fmtWindow(until - since)}
              />
            )}
            {history && opened && (
              <FlowHistoryNote
                history={history}
                job={fromHistory.job}
                starting={fromHistory.starting}
                error={fromHistory.error}
                onStart={fromHistory.start}
                onCancel={fromHistory.cancel}
              />
            )}
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
          {!wide && cardOpen && (
            <PanelResize label="Resize inspector" size={INSPECTOR} width={cardW} onWidth={setCardW} />
          )}
          {cardOpen && (
            <FieldCard
              key={line.id}
              onClose={() => setCardOpen(false)}
              line={line}
              position={{ index, total: flow.nodes.length }}
              onPrev={() => move(-1)}
              onNext={() => move(1)}
              subtitle={node.attempt != null ? `attempt ${node.attempt}` : undefined}
              title={node.name}
              diagram={diagram}
              onDiagramChange={setDiagram}
              className={cn(wide ? 'w-auto flex-1' : 'w-[var(--card-w)]')}
            />
          )}
        </div>
      )}
      {exporting && (
        <ExportDialog
          open={exporting}
          onOpenChange={setExporting}
          title="Export flow"
          description="Linked, stored events in completion-time order. Missing events stay missing."
          params={{ id: flow.ids.map((i) => i.value).join(',') || undefined, since: flow.started, until: flow.ended }}
          fixedRange={`${fmtTime(flow.started)} - ${fmtTime(flow.ended)} · stored completions`}
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
            [
              `${activity.completions} completion ${activity.completions === 1 ? 'event' : 'events'}`,
              [
                activity.requests && `${activity.requests} ${activity.requests === 1 ? 'request' : 'requests'}`,
                activity.jobs && `${activity.jobs} ${activity.jobs === 1 ? 'job' : 'jobs'}`,
              ]
                .filter(Boolean)
                .join(' + '),
              bytes != null && fmtBytes(bytes),
            ]
              .filter(Boolean)
              .join(' · ')
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
        The Diagram and JSON tabs stay visible but disabled, so the card keeps its shape from line to line. Fields shows
        what quiet could read: level, time, status, path.
      </p>
      <p className="mt-3 text-muted-foreground">
        {hint
          ? 'For structured fields and Diagram, enable JSON access logs:'
          : `For structured fields and Diagram, log one JSON object per line (pino, zap, structlog, slog's JSON handler)${kind ? ` or switch the ${kind} shipper to JSON` : ''}.`}
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
    <aside className="flex min-w-[280px] max-w-[480px] flex-1 flex-col gap-6">
      {!line.fields && (
        <PlainTextNote
          source={line.source}
          kind={kind && kind !== 'docker' && kind !== 'http' ? kindLabel(kind) : undefined}
        />
      )}
      <div className="border border-dashed p-4">
        <h2 className="flex items-center gap-2 font-medium">
          <GitForkIcon className="size-4 text-muted-foreground" />
          Only one event observed
        </h2>
        <p className="mt-2 text-muted-foreground">
          {id
            ? `This is the only event found for ${id.value}. Sampling, delivery gaps or expiry may leave related work unseen. Missing completion is not evidence of failure.`
            : 'This event carries no request, job, trace or correlation id, so there is nothing to correlate.'}
        </p>
        <dl className="mt-3 font-mono text-xs">
          {[
            ['checked', 'request_id → job_id → trace_id → correlation_id'],
            ['window', `last ${fmtWindow(until - since)} · all ${sources ?? ''} sources`.replace('  ', ' ')],
            ['matches', '1 event'],
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
  // v0.1.1-04.5: the flow layout either way; close matches only when there are some.
  return (
    <div className="flex flex-1 flex-col px-6 pb-4">
      <Crumbs label={/^req_/.test(nf.id) ? 'request_id' : undefined} value={nf.id} />
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
          <h2 className="font-medium">No events with this ID</h2>
          <p className="text-muted-foreground">
            No received event in the last {window} carries {nf.id}. Check the ID and source. Sampling, delivery gaps or
            expiry can also leave no match.
          </p>
          <Button nativeButton={false} render={<Link to="/search" search={{ q: nf.id, range: '24h' }} />}>
            <SearchIcon />
            Search all sources
          </Button>
        </div>
        {nf.close.length > 0 && (
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
        )}
        <p className="flex items-center gap-2 text-muted-foreground text-xs">
          <ClockIcon className="size-3.5" />
          <span>Showing the last {window}. Retention settings cannot restore expired events.</span>
        </p>
      </div>
    </div>
  )
}

/** A flow link with nothing like it left in the window (design 08.6). */
