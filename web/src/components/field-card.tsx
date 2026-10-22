import { useNavigate } from '@tanstack/react-router'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  FilterIcon,
  GitForkIcon,
  ListIcon,
  WrapTextIcon,
  XIcon,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { LevelBadge } from '@/components/level-badge'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { LogLine } from '@/gen'
import { useSources } from '@/lib/api'
import { kindLabel } from '@/lib/connect'
import { bytes, fmtTime } from '@/lib/format'
import { toast } from '@/lib/toast'
import { useHotkeys } from '@/lib/use-hotkeys'
import { cn } from '@/lib/utils'

type Tab = 'fields' | 'json' | 'raw'

/** Flatten nested objects to dotted keys (3 levels), keeping arrays and deeper objects as JSON. */
export function flatten(obj: Record<string, unknown>, prefix = '', depth = 0, out: [string, unknown][] = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2)
      flatten(v as Record<string, unknown>, key, depth + 1, out)
    else out.push([key, v])
  }
  return out
}

/** Card sections, in order; a field goes to the first whose test matches, else "other". */
const SECTIONS: [string, (k: string) => boolean][] = [
  [
    'identity',
    (k) =>
      /(^|\.)(request_id|requestId|req_id|job_id|jobId|trace_id|traceId|span_id|correlation_id|user_id|device_id|session_id|account_id)$/.test(
        k,
      ),
  ],
  ['request', (k) => /^(method|path|route|url|query|status|status_code|statusCode|duration_ms|bytes)$/.test(k)],
  [
    'job',
    (k) =>
      /^(queue|operation|phase|step|outcome|attempt|retry_attempt|attemptsMade|delivery_count|flow|backoff_ms|retries_left|row|field|reason)$/.test(
        k,
      ),
  ],
  ['error', (k) => /^(err|error)(\.|$)/.test(k)],
  ['client', (k) => /^(ip|ip_address|client_ip|user_agent|userAgent|x-forwarded-for)$/.test(k)],
  ['sampling', (k) => /^(should_sample|sample_reason|sampled)$/.test(k)],
  [
    'host',
    (k) =>
      /^(service|source|hostname|host|pid|instance_id|commit_sha|version|env|time|timestamp|ts|@timestamp|level|msg|message)$/.test(
        k,
      ),
  ],
]
const ORDER = ['identity', 'request', 'job', 'error', 'client', 'sampling', 'other', 'host']

export function sections(fields: Record<string, unknown>): { name: string; rows: [string, unknown][] }[] {
  const by = new Map<string, [string, unknown][]>()
  for (const row of flatten(fields)) {
    const name = SECTIONS.find(([, test]) => test(row[0]))?.[0] ?? 'other'
    by.set(name, [...(by.get(name) ?? []), row])
  }
  return ORDER.filter((n) => by.has(n)).map((name) => ({ name, rows: by.get(name) ?? [] }))
}

function kind(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'arr'
  if (typeof v === 'number') return 'num'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'object') return 'obj'
  return 'str'
}

function Value({ v }: { v: unknown }) {
  if (v === null) return <span className="text-syntax-literal">null</span>
  if (typeof v === 'number') return <span className="text-syntax-number">{v}</span>
  if (typeof v === 'boolean') return <span className="text-syntax-literal">{String(v)}</span>
  if (typeof v === 'string') return <span className="text-syntax-string">{v}</span>
  return <span className="text-muted-foreground">{JSON.stringify(v)}</span>
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`Copied ${what}`)
  } catch {
    toast.error('Clipboard is not available here')
  }
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))

/** One JSON line, coloured: keys periwinkle, strings, numbers amber, literals green. */
function JsonLine({ text }: { text: string }) {
  const parts: ReactNode[] = []
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g
  let last = 0
  let i = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    if (m[1] && m[2]) {
      parts.push(
        <span key={i++} className="text-syntax-key">
          {m[1]}
        </span>,
        m[2],
      )
    } else if (m[1]) {
      parts.push(
        <span key={i++} className="text-syntax-string">
          {m[1]}
        </span>,
      )
    } else if (m[3]) {
      parts.push(
        <span key={i++} className="text-syntax-number">
          {m[3]}
        </span>,
      )
    } else {
      parts.push(
        <span key={i++} className="text-syntax-literal">
          {m[4]}
        </span>,
      )
    }
    last = m.index + m[0].length
  }
  parts.push(text.slice(last))
  return <>{parts}</>
}

export function JsonView({ json }: { json: string }) {
  const lines = json.split('\n')
  return (
    <pre data-testid="json-view" className="bg-code py-3 font-mono text-xs leading-relaxed">
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines of one document
        <div key={i} className="flex">
          <span className="w-9 shrink-0 select-none pr-3 text-right text-muted-foreground/60">{i + 1}</span>
          <span className="whitespace-pre-wrap break-all pr-3">
            <JsonLine text={l} />
          </span>
        </div>
      ))}
    </pre>
  )
}

function save(text: string, file: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = file
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** `· level 50 → error` when the line's level came from a number. */
function levelNote(l: LogLine): string {
  const v = l.fields?.level ?? l.fields?.severity ?? l.fields?.lvl
  return l.level && v != null && String(v) !== l.level ? ` · level ${String(v)} → ${l.level}` : ''
}

/**
 * One line: Fields (by section), JSON and Raw. The stream shows it beside the
 * table; a flow shows it for the selected step node.
 */
export function FieldCard({
  line,
  position,
  onClose,
  onPrev,
  onNext,
  onOpenFlow,
  onOpenInStream,
  hotkeys,
  subtitle,
  title,
  className,
}: {
  /** Replaces the line's message as the heading (a flow shows the step name). */
  title?: string
  line: LogLine
  position?: { index: number; total: number }
  onClose?: () => void
  onPrev?: () => void
  onNext?: () => void
  /** Shown as "Open flow" when the line belongs to one. */
  onOpenFlow?: () => void
  /** A third action: the line in the stream (one-node flows, design 04.4). */
  onOpenInStream?: () => void
  /** Listen for C / F (design 08.2): only the card that owns the page. */
  hotkeys?: boolean
  /** Replaces the source in the header (`attempt 2`, `row 28`). */
  subtitle?: string
  className?: string
}) {
  const navigate = useNavigate()
  const sources = useSources().data
  const [tab, setTab] = useState<Tab>(line.fields ? 'fields' : 'raw')
  const [wrap, setWrap] = useState(true)
  const [picked, setPicked] = useState<string | null>(null)
  const active: Tab = !line.fields && tab !== 'raw' ? 'raw' : tab
  const json = line.fields ? JSON.stringify(line.fields, null, 2) : ''
  const bad = line.level === 'error' || line.level === 'fatal'
  const groups = line.fields ? sections(line.fields) : []
  const count = groups.reduce((n, g) => n + g.rows.length, 0)
  const pickedValue = picked != null ? groups.flatMap((g) => g.rows).find(([k]) => k === picked)?.[1] : undefined

  // A new line resets the picked field.
  const [shownId, setShownId] = useState(line.id)
  if (shownId !== line.id) {
    setShownId(line.id)
    setPicked(null)
  }

  const copyJson = () => copy(line.fields ? json : JSON.stringify({ raw: line.raw }), 'line as JSON')
  useHotkeys(
    hotkeys
      ? {
          c: copyJson,
          f: () => filter(),
        }
      : {},
  )

  const filter = () => {
    if (picked == null) return
    const v = asText(pickedValue)
    navigate({ to: '/search', search: { q: `${picked}:${/\s/.test(v) ? `"${v}"` : v}` } })
  }

  return (
    <section aria-label="Line details" className={cn('flex min-h-0 w-100 shrink-0 flex-col border bg-card', className)}>
      <header className="flex flex-col gap-2 border-b p-4">
        <div className="flex items-start gap-2">
          <StatusDot status={bad ? 'err' : line.level === 'warn' ? 'warn' : 'ok'} className="mt-1.5" />
          <h2 className="line-clamp-2 flex-1 break-all font-medium font-mono text-[13px]">{title ?? line.msg}</h2>
          {onOpenFlow && (
            <IconButton label="Open flow (enter)" onClick={onOpenFlow}>
              <GitForkIcon />
            </IconButton>
          )}
          <IconButton label="Copy raw line" onClick={() => copy(line.raw, 'raw line')}>
            <CopyIcon />
          </IconButton>
          {onClose && (
            <IconButton label="Close (esc)" onClick={onClose}>
              <XIcon />
            </IconButton>
          )}
        </div>
        <div className="flex items-center gap-2 font-mono text-muted-foreground text-xs">
          <LevelBadge level={line.level} />
          <span title={new Date(line.ts).toISOString()}>{fmtTime(line.ts)}</span>
          <span className="truncate">· {subtitle ?? line.source}</span>
          <span className="flex-1" />
          {position && (
            <>
              <span className="tabular-nums">
                {position.index + 1} / {position.total}
              </span>
              {onPrev && (
                <IconButton label="Previous (k)" onClick={onPrev}>
                  <ChevronLeftIcon />
                </IconButton>
              )}
              {onNext && (
                <IconButton label="Next (j)" onClick={onNext}>
                  <ChevronRightIcon />
                </IconButton>
              )}
            </>
          )}
        </div>
        {line.flags && line.flags.length > 0 && (
          <div className="font-mono text-[11px] text-status-warn">{line.flags.join(' · ')}</div>
        )}
      </header>

      <Tabs value={active} onValueChange={(v) => setTab(v as Tab)} className="min-h-0 flex-1 gap-0 p-4">
        <div className="flex items-center justify-between pb-3">
          <TabsList>
            <TabsTrigger value="fields" disabled={!line.fields}>
              Fields
            </TabsTrigger>
            <TabsTrigger value="json" disabled={!line.fields}>
              JSON
            </TabsTrigger>
            <TabsTrigger value="raw">Raw</TabsTrigger>
          </TabsList>
          <span className="font-mono text-[11px] text-muted-foreground">
            {line.fields ? `${count} fields` : `${bytes(line.raw)} B`}
          </span>
        </div>
        <TabsContent value="fields" className="min-h-0 overflow-y-auto">
          {groups.map((g) => (
            <div key={g.name} className="font-mono text-xs">
              <div className="flex justify-between pt-3 pb-1 text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
                <span>{g.name}</span>
                <span>{g.rows.length}</span>
              </div>
              <fieldset aria-label={g.name} className="m-0 min-w-0 border-0 p-0">
                {g.rows.map(([k, v]) => (
                  <button
                    type="button"
                    key={k}
                    aria-pressed={picked === k}
                    onClick={() => setPicked(picked === k ? null : k)}
                    className={cn(
                      'grid w-full grid-cols-[minmax(0,2fr)_minmax(0,3fr)_32px] gap-3 border-border/60 border-b py-1.5 text-left hover:bg-row-hover',
                      picked === k && 'bg-row-selected',
                    )}
                  >
                    <span className="truncate text-syntax-key" title={k}>
                      {k}
                    </span>
                    <span className="break-all">
                      <Value v={v} />
                    </span>
                    <span className="text-right text-[11px] text-muted-foreground">{kind(v)}</span>
                  </button>
                ))}
              </fieldset>
            </div>
          ))}
        </TabsContent>
        <TabsContent value="json" className="min-h-0 overflow-auto">
          <JsonView json={json} />
        </TabsContent>
        <TabsContent value="raw" className="min-h-0 overflow-auto">
          <pre
            data-testid="raw-view"
            className={cn(
              'bg-code p-3 font-mono text-xs leading-relaxed',
              wrap ? 'whitespace-pre-wrap break-all' : 'overflow-x-auto whitespace-pre',
            )}
          >
            {line.raw}
          </pre>
          <dl className="mt-3 font-mono text-xs">
            {(
              [
                [
                  'received',
                  `${fmtTime(line.received)} · ${line.received - line.ts >= 0 ? '+' : ''}${line.received - line.ts}ms`,
                ],
                ['via', `${kindLabel(sources?.find((x) => x.name === line.source)?.kind ?? 'http')} · ${line.source}`],
                ['size', `${bytes(line.raw).toLocaleString()} bytes`],
                [
                  'parsed',
                  line.fields
                    ? `json · ${Object.keys(line.fields).length} keys${levelNote(line)}`
                    : 'text · kept as a raw line',
                ],
                ...line.ids.map((i) => [i.key, i.value]),
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k + v} className="grid grid-cols-[96px_1fr] border-border/60 border-b py-1.5">
                <dt className="text-syntax-key">{k}</dt>
                <dd className="break-all">{v}</dd>
              </div>
            ))}
          </dl>
        </TabsContent>
      </Tabs>
      <footer
        className={cn('grid gap-2 border-t p-3', onOpenInStream && active === 'fields' ? 'grid-cols-3' : 'grid-cols-2')}
      >
        {active === 'json' ? (
          <>
            <Button variant="outline" onClick={copyJson}>
              <CopyIcon />
              Copy as JSON
            </Button>
            <Button variant="outline" onClick={() => save(json, `quiet-line-${line.id}.json`)}>
              <DownloadIcon />
              Download .json
            </Button>
          </>
        ) : active === 'raw' ? (
          <>
            <Button variant="outline" onClick={() => copy(line.raw, 'raw line')}>
              <CopyIcon />
              Copy raw line
            </Button>
            <Button variant="outline" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
              <WrapTextIcon />
              {wrap ? 'Wrap' : 'No wrap'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" disabled={picked == null} onClick={filter}>
              <FilterIcon />
              {picked ? `Filter by ${picked}` : 'Filter by value'}
            </Button>
            <Button variant="outline" onClick={copyJson}>
              <CopyIcon />
              Copy as JSON
            </Button>
            {onOpenInStream && (
              <Button variant="outline" onClick={onOpenInStream}>
                <ListIcon />
                Open in stream
              </Button>
            )}
          </>
        )}
      </footer>
    </section>
  )
}
