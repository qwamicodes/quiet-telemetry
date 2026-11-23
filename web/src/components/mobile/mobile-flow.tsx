import { Link } from '@tanstack/react-router'
import { ArrowLeftIcon, CopyIcon } from 'lucide-react'
import { FieldCard } from '@/components/field-card'
import type { Flow, LogLine } from '@/gen'
import { fmtDuration } from '@/lib/flow'
import { rowParts } from '@/lib/row'
import { cn } from '@/lib/utils'

type Tone = 'ok' | 'warn' | 'err' | 'muted' | 'brand' | 'idle'

/** The step's name; a message that is raw JSON reads as its flow / job name instead. */
function stepName(node: Flow['nodes'][number], line: LogLine | undefined): string {
  if (!node.name.trimStart().startsWith('{') || !line) return node.name
  const p = rowParts(line)
  return p.path ? `${p.method} ${p.path}` : p.event || (p.name ?? node.name)
}

/** `attempt 2 · TRANSFER_TIMEOUT`, `POST /api/v1/payouts → 201`, else the step name. */
function stepLabel(node: Flow['nodes'][number], line: LogLine | undefined): string {
  const p = line ? rowParts(line) : null
  if (node.attempt != null) {
    // The row's extras repeat the attempt (`attempt 2`, `final`): keep the reason only.
    const why = p?.extra.find((x) => !/^attempt \d|^final$/.test(x)) ?? (p?.tone === 'err' ? p.outcome : undefined)
    return [`attempt ${node.attempt}`, why].filter(Boolean).join(' · ')
  }
  if (p?.path && p.outcome != null) return `${p.method} ${p.path} → ${p.outcome}`
  return stepName(node, line)
}

/**
 * A flow on a phone (board 10.2): back to the stream, the flow's name and
 * status, its steps as stacked cards, and the selected step's field card as a
 * bottom sheet.
 */
export function MobileFlow({
  flow,
  title,
  badge,
  tone,
  source,
  index,
  onSelect,
  onPrev,
  onNext,
  onCopy,
}: {
  flow: Flow
  title: string
  badge: string
  tone: Tone
  /** The stream "← Stream" goes back to. */
  source: string
  index: number
  onSelect: (lineId: number) => void
  onPrev: () => void
  onNext: () => void
  onCopy: () => void
}) {
  const node = flow.nodes[index]
  const byId = new Map(flow.lines.map((l) => [l.id, l]))
  const line = byId.get(node.line_id) as LogLine
  const events = flow.line_count
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-1.5 px-4 pt-1 pb-3">
        <div className="flex items-center gap-1.5">
          <Link
            to="/"
            search={{ source }}
            className="-ml-2 flex h-6 items-center gap-1.5 px-2 font-medium text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ArrowLeftIcon className="size-3.5" />
            Stream
          </Link>
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Copy flow JSON"
            onClick={onCopy}
            className="flex size-6 items-center justify-center outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <CopyIcon className="size-3.5" />
          </button>
        </div>
        <h1 className="truncate font-mono font-semibold text-[18px] leading-6 tracking-tight">{title}</h1>
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'flex h-5 shrink-0 items-center px-1.5 font-medium font-mono text-[11px] leading-3',
              tone === 'err' && 'bg-level-error-muted text-level-error',
              tone === 'warn' && 'bg-level-warn-muted text-level-warn',
              tone === 'ok' && 'bg-status-ok/10 text-status-ok',
              (tone === 'muted' || tone === 'idle') && 'bg-secondary text-muted-foreground',
              tone === 'brand' && 'bg-level-info-muted text-level-info',
            )}
          >
            {badge}
          </span>
          <span className="truncate font-mono text-muted-foreground text-xs">
            {events} {events === 1 ? 'event' : 'events'} · {fmtDuration(flow.duration_ms)}
          </span>
        </div>
      </header>
      <ol aria-label="Steps" className="flex max-h-[40%] shrink-0 flex-col gap-1.5 overflow-y-auto px-4 pb-3">
        {flow.nodes.map((n, i) => {
          const sel = i === index
          return (
            <li key={n.line_id}>
              <button
                type="button"
                aria-current={sel ? 'step' : undefined}
                onClick={() => onSelect(n.line_id)}
                className={cn(
                  'flex h-9 w-full items-center gap-2.5 border bg-card px-3 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  sel && 'border-brand bg-row-selected font-medium',
                )}
              >
                <span
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    n.error ? 'bg-status-err' : n.warn ? 'bg-status-warn' : 'bg-status-ok',
                  )}
                />
                <span className="min-w-0 truncate">{stepLabel(n, byId.get(n.line_id))}</span>
                <span className="flex-1" />
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {n.duration_ms == null ? '—' : fmtDuration(n.duration_ms)}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
      {/* The selected step's card as a bottom sheet. */}
      <div className="flex min-h-0 flex-1 flex-col border-t bg-popover shadow-[0_-16px_40px_rgb(0_0_0/0.4)]">
        <div className="flex shrink-0 justify-center pt-2 pb-1">
          <span aria-hidden className="h-1 w-9 bg-input" />
        </div>
        <FieldCard
          key={line.id}
          line={line}
          position={{ index, total: flow.nodes.length }}
          onPrev={onPrev}
          onNext={onNext}
          subtitle={node.attempt != null ? `attempt ${node.attempt}` : undefined}
          title={stepName(node, line)}
          className="w-full flex-1 border-0 bg-popover"
        />
      </div>
    </div>
  )
}
