import { ChevronDownIcon, ChevronRightIcon, MaximizeIcon, MinimizeIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import type { CorrId, LogLine } from '@/gen'
import {
  type Activity,
  type Attempt,
  activityCounts,
  buildActivity,
  type JobRow,
  type OtherRow,
  type RequestRow,
  retryDelays,
  type Tone,
} from '@/lib/activity'
import { fmtDuration } from '@/lib/flow'
import { fmtTime } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Row timings read `350 ms`, a space before the unit (04.1 … 04.3). */
const dur = (ms: number | null | undefined) => fmtDuration(ms).replace(/^(\d+(?:\.\d+)?)(ms|s)$/, '$1 $2')

const TONE: Record<Tone, string> = {
  ok: 'text-status-ok',
  warn: 'text-status-warn',
  err: 'text-status-err',
  muted: 'text-muted-foreground',
}

/** One activity row: title + subtitle, state, timing; a selected row is marked like a stream row. */
function Row({
  selected,
  depth = 0,
  expander,
  title,
  sub,
  state,
  tone,
  timing,
  onClick,
  label,
}: {
  selected: boolean
  depth?: number
  expander?: ReactNode
  title: ReactNode
  sub: ReactNode
  state: ReactNode
  tone: Tone
  timing: ReactNode
  onClick: () => void
  label: string
}) {
  return (
    <div
      className={cn(
        'relative grid min-h-15 grid-cols-[20px_minmax(0,1fr)_minmax(0,200px)_120px] items-center gap-3 border-border/60 border-b pr-3 font-mono text-[13px] hover:bg-row-hover',
        selected && 'bg-row-selected shadow-[inset_2px_0_0_var(--brand)]',
      )}
      style={{ paddingLeft: 12 + depth * 24 }}
    >
      <button
        type="button"
        aria-label={label}
        aria-pressed={selected}
        onClick={onClick}
        className="absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      />
      <span className="relative z-10 flex justify-center text-muted-foreground">{expander ?? '·'}</span>
      <span className="flex min-w-0 flex-col gap-0.5 py-2">
        <span className="truncate">{title}</span>
        <span className="truncate text-[11px] text-muted-foreground">{sub}</span>
      </span>
      <span className={cn('truncate', TONE[tone])}>{state}</span>
      <span className="text-right text-muted-foreground text-xs tabular-nums">{timing}</span>
    </div>
  )
}

function Section({ children }: { children: ReactNode }) {
  return (
    <div className="border-border/60 border-b px-3 pt-4 pb-2 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
      {children}
    </div>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p className="border-border/60 border-b px-4 py-3 font-mono text-[11px] text-muted-foreground">{children}</p>
}

function RequestItem({ r, selected, onSelect }: { r: RequestRow; selected: number; onSelect: (id: number) => void }) {
  return (
    <Row
      label={`${r.method} ${r.path}`}
      selected={r.line.id === selected}
      title={
        <>
          {r.method} {r.path}
        </>
      }
      sub={[r.line.source, r.flow].filter(Boolean).join(' · ')}
      state={r.label}
      tone={r.tone}
      timing={r.duration != null ? dur(r.duration) : '–'}
      onClick={() => onSelect(r.line.id)}
    />
  )
}

function AttemptItem({ a, selected, onSelect }: { a: Attempt; selected: number; onSelect: (id: number) => void }) {
  const level = a.line.level ?? 'info'
  return (
    <Row
      label={a.title}
      depth={1}
      selected={a.line.id === selected}
      title={a.title}
      sub={[fmtTime(a.line.ts).slice(0, 12), a.detail].filter(Boolean).join(' · ')}
      state={[level, a.final && 'final'].filter(Boolean).join(' · ')}
      tone={a.tone}
      timing={a.duration != null ? dur(a.duration) : '–'}
      onClick={() => onSelect(a.line.id)}
    />
  )
}

/** `1 attempt`, `3 attempts`; nothing for a job the queue only reported. */
function attemptsText(j: JobRow): string | null {
  const n = j.attempts.filter((a) => a.n != null || a.duration != null).length
  return n ? `${n} ${n === 1 ? 'attempt' : 'attempts'}` : null
}

function JobItem({
  j,
  depth = 0,
  selected,
  onSelect,
}: {
  j: JobRow
  depth?: number
  selected: number
  onSelect: (id: number) => void
}) {
  const inside = j.attempts.some((a) => a.line.id === selected)
  // Top-level jobs with retries or no completion start open; child jobs (04.3) start folded.
  const [open, setOpen] = useState(inside || (depth === 0 && (j.attempts.length > 1 || j.state !== 'completed')))
  const head = j.attempts[j.attempts.length - 1].line
  return (
    <>
      <Row
        label={`${j.flow} job ${j.jobId}`}
        depth={depth}
        selected={!open && inside}
        expander={
          <button
            type="button"
            aria-label={open ? `Collapse ${j.jobId}` : `Expand ${j.jobId}`}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="flex size-5 items-center justify-center hover:text-foreground"
          >
            {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
          </button>
        }
        title={j.flow}
        // A child job (04.3) reads `stock-1182 · inventory · 1 attempt`; a top-level job keeps its source.
        sub={
          depth > 0
            ? [j.jobId, j.queue, attemptsText(j)].filter(Boolean).join(' · ')
            : [j.source, j.queue, j.jobId].filter(Boolean).join(' · ')
        }
        state={j.label}
        tone={j.tone}
        timing={
          j.exec != null ? (
            <>
              Exec {dur(j.exec)}
              {j.lastN != null && ` · #${j.lastN}`}
            </>
          ) : (
            '–'
          )
        }
        onClick={() => {
          setOpen(true)
          onSelect(head.id)
        }}
      />
      {open && j.attempts.map((a) => <AttemptItem key={a.line.id} a={a} selected={selected} onSelect={onSelect} />)}
      {open && j.children.length > 0 && (
        <>
          <Section>Child jobs · queue relationships confirmed</Section>
          {j.children.map((c) => (
            <JobItem key={c.key} j={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))}
          <Note>
            Children run independently. Parent completion does not complete its children.
            {j.children.some((c) => c.state === 'queued') && ' Queued is confirmed by the queue.'}
          </Note>
        </>
      )}
    </>
  )
}

function OtherItem({ o, selected, onSelect }: { o: OtherRow; selected: number; onSelect: (id: number) => void }) {
  return (
    <Row
      label={o.title}
      selected={o.line.id === selected}
      title={o.title}
      sub={`${o.line.source} · application log · ${fmtTime(o.line.ts).slice(0, 12)}`}
      state={o.line.level ?? 'log'}
      tone={o.tone}
      timing="–"
      onClick={() => onSelect(o.line.id)}
    />
  )
}

/**
 * Flow's default view (v0.1.1-04.1 … 04.5): requests and logical jobs, attempts
 * inside their job, related requests and evidenced child jobs. Timing shows
 * the timeline and graph instead.
 */
export function ActivityList({
  lines,
  opened,
  selected,
  onSelect,
  timing,
  onTiming,
  full = false,
  onFull,
  window = '24h',
}: {
  /** Full screen (04.17): the activity list and inspector cover the app. */
  full?: boolean
  onFull?: () => void
  /** The flow window for the footer (`last 24h`). */
  window?: string
  lines: LogLine[]
  opened: CorrId | null
  selected: number
  onSelect: (lineId: number) => void
  timing: boolean
  onTiming: (on: boolean) => void
}) {
  const a: Activity = buildActivity(lines, opened)
  const jobs = a.main.filter((r): r is JobRow => r.kind === 'job')
  const requestId = lines.flatMap((l) => l.ids).find((i) => i.key === 'request_id')
  // With child jobs (04.3) the request that started it all leads the list and the counts.
  const parentage = jobs.some((j) => j.children.length > 0)
  return (
    <section aria-label="Activity" className="flex min-h-0 flex-1 flex-col border bg-card">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className="flex-1 text-[13px]">Activity · {activityCounts(a, { related: parentage })}</span>
        <Button variant="outline" size="xs" aria-pressed={timing} onClick={() => onTiming(!timing)}>
          Timing
        </Button>
        {onFull && (
          <Button variant="outline" size="xs" aria-pressed={full} onClick={onFull}>
            {full ? <MinimizeIcon /> : <MaximizeIcon />}
            {full ? 'Exit full screen' : 'Full screen'}
            {full && <Kbd className="ml-1">Esc</Kbd>}
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {parentage &&
          a.related.map((r) => <RequestItem key={r.line.id} r={r} selected={selected} onSelect={onSelect} />)}
        {a.main.map((r) =>
          r.kind === 'request' ? (
            <RequestItem key={r.line.id} r={r} selected={selected} onSelect={onSelect} />
          ) : (
            <JobItem key={r.key} j={r} selected={selected} onSelect={onSelect} />
          ),
        )}
        {a.requests > 0 && jobs.length > 0 && opened?.key !== 'job_id' && requestId && (
          <Note>Related by request_id {requestId.value}. Queue timing is available in Timing.</Note>
        )}
        {jobs.length > 0 && opened?.key === 'job_id' && !parentage && (
          <Note>
            {jobs[0].state === 'failed'
              ? 'Queue confirms terminal failure.'
              : jobs[0].state === 'not_observed'
                ? 'No completion observed for the last attempt; its state is unknown.'
                : 'Attempts as the queue numbered them.'}
            {retryDelays(jobs[0]) && ` Retry delays: ${retryDelays(jobs[0])}.`} Timing shows queue and execution
            measurements.
          </Note>
        )}
        {a.related.length > 0 && !parentage && (
          <>
            <Section>Related request</Section>
            {a.related.map((r) => (
              <RequestItem key={r.line.id} r={r} selected={selected} onSelect={onSelect} />
            ))}
          </>
        )}
        {a.other.length > 0 && (
          <>
            <Section>Other events</Section>
            {a.other.map((o) => (
              <OtherItem key={o.line.id} o={o} selected={selected} onSelect={onSelect} />
            ))}
          </>
        )}
      </div>
      <footer className="shrink-0 border-t px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {parentage
          ? 'Execution times belong to the selected attempt · open Timing for wait and total'
          : opened?.key === 'job_id' && jobs[0]
            ? `Scope: ${jobs[0].source}${jobs[0].queue ? ` / ${jobs[0].queue}` : ''} · ${
                jobs[0].state === 'not_observed'
                  ? 'no queue lifecycle evidence yet'
                  : 'queue lifecycle evidence available'
              }`
            : `${a.completions} completion ${a.completions === 1 ? 'event' : 'events'} · last ${window} · select a row to inspect its event`}
      </footer>
    </section>
  )
}
