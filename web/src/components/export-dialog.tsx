import { useQuery } from '@tanstack/react-query'
import {
  CheckIcon,
  CornerDownLeftIcon,
  FileDownIcon,
  GripVerticalIcon,
  InfoIcon,
  PlusIcon,
  TerminalIcon,
  XIcon,
} from 'lucide-react'
import { type ReactNode, useState, useSyncExternalStore } from 'react'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { ExportFormat, ExportJob, SearchParams } from '@/gen'
import { fetchJson, sendJson, useHealth } from '@/lib/api'
import { fmtBytes, fmtClock, fmtCount, fmtWindow } from '@/lib/format'
import { exportJob, searchResponse } from '@/lib/schemas'
import { copyCurl, type ExportOptions, exportFileName, exportQuery, toQuery } from '@/lib/search-api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

/** CSV columns on by default, and the ones offered to add (design 05.5). */
export const DEFAULT_COLUMNS = ['timestamp', 'level', 'source', 'request_id', 'msg', 'status', 'duration_ms']
const SUGGESTED = ['job_id', 'method', 'path', 'user_id', 'error.message']
/** Over this many lines the server prepares the file first, with progress (design 05.7). */
export const LARGE = 100_000

const FORMATS: { value: ExportFormat; title: string; hint: string }[] = [
  { value: 'ndjson', title: 'NDJSON', hint: 'Raw lines exactly as received, one per line.' },
  { value: 'json', title: 'JSON array', hint: 'One array of parsed lines with their fields.' },
  { value: 'csv', title: 'CSV', hint: 'Pick columns. Opens in any spreadsheet.' },
]

// ---- server-side preparing (05.7 / 05.8; survives closing the dialog) ------------------

/** The export being prepared on the server, as last polled. */
export interface Job {
  id: string
  file: string
  total: number
  done: number
  started: number
  etaMs: number | null
  ready: boolean
}
let job: Job | null = null
const subs = new Set<() => void>()
const emit = () => {
  for (const s of subs) s()
}
function useJob() {
  return useSyncExternalStore(
    (l) => {
      subs.add(l)
      return () => subs.delete(l)
    },
    () => job,
    () => null,
  )
}
/** How often the progress is polled, ms (tests shorten it). */
export const POLL = { ms: 1000 }

/** The browser saves the prepared file straight from the server. */
export function downloadJob(id: string, file: string) {
  const a = document.createElement('a')
  a.href = `/api/export/jobs/${encodeURIComponent(id)}/download`
  a.download = file
  a.click()
}

/** Cancel the export being prepared (the server deletes the partial file). */
export async function cancelServerExport() {
  const j = job
  if (!j) return
  job = null
  emit()
  await sendJson(`/api/export/jobs/${encodeURIComponent(j.id)}`, { method: 'DELETE' }).catch(() => {})
  toast.info('Export cancelled', { description: j.file })
}

/**
 * Ask the server to prepare the file, poll its progress, then offer it in a
 * toast ("Export ready · file · size · Download"). One at a time from here.
 */
export async function runServerExport(query: string) {
  if (job && !job.ready) return
  let j: ExportJob
  try {
    j = await fetchJson('/api/export/jobs', exportJob, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    })
  } catch (e) {
    toast.error('Export failed', { description: e instanceof Error ? e.message : String(e) })
    return
  }
  const id = j.id
  const show = (x: ExportJob) => {
    job = {
      id,
      file: x.file_name,
      total: x.total,
      done: x.done,
      started: x.started,
      etaMs: x.eta_ms,
      ready: x.state === 'ready',
    }
    emit()
  }
  show(j)
  while (j.state === 'preparing') {
    await new Promise((r) => setTimeout(r, POLL.ms))
    if (job?.id !== id) return // cancelled
    try {
      j = await fetchJson(`/api/export/jobs/${encodeURIComponent(id)}`, exportJob)
    } catch (e) {
      if (job?.id !== id) return
      job = null
      emit()
      toast.error('Export failed', { description: e instanceof Error ? e.message : String(e) })
      return
    }
    if (job?.id !== id) return
    show(j)
  }
  if (j.state === 'ready') {
    const { file_name: file, bytes } = j
    toast.success('Export ready', {
      description: `${file} · ${fmtBytes(bytes)}`,
      duration: null,
      button: {
        title: 'Download',
        onClick: () => {
          downloadJob(id, file)
          if (job?.id === id) {
            job = null
            emit()
          }
        },
      },
    })
    // The dialog's Download stays on this file until it is used or replaced.
    return
  }
  job = null
  emit()
  if (j.state === 'failed') toast.error('Export failed', { description: j.error ?? undefined })
}

function Progress({ j }: { j: Job }) {
  const pct = j.ready ? 100 : Math.min(99, Math.floor((j.done / Math.max(1, j.total)) * 100))
  const left = j.etaMs != null ? Math.max(1, Math.round(j.etaMs / 1000)) : null
  return (
    <section aria-label="Export progress" className="flex flex-col gap-2 border bg-background/40 p-3">
      <div className="flex items-center gap-3 font-mono text-xs">
        <StatusDot status={j.ready ? 'ok' : 'warn'} />
        <span className="font-sans font-medium text-sm">
          {j.ready ? `Ready · ${fmtCount(j.total)} lines` : `Preparing ${fmtCount(j.total)} lines · ${pct}%`}
        </span>
        {!j.ready && (
          <span className="text-muted-foreground">
            {fmtCount(j.done)} / {fmtCount(j.total)}
            {left != null && ` · ~${left}s left`}
          </span>
        )}
        <span className="flex-1" />
        {!j.ready && (
          <Button variant="outline" size="xs" onClick={() => cancelServerExport()}>
            <XIcon />
            Cancel
          </Button>
        )}
      </div>
      <div className="h-1 bg-muted">
        <div className="h-full bg-brand transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-muted-foreground text-xs">
        Over ~{fmtCount(LARGE)} lines quiet prepares the file on the server first. You can close this; a toast tells you
        when it is ready. Lines that expire meanwhile are still included.
      </p>
    </section>
  )
}

// ---- dialog --------------------------------------------------------------------------

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-3 border-border/60 border-b py-1 last:border-b-0">
      <span className="w-24 shrink-0 font-mono text-muted-foreground text-xs">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-xs">{children}</div>
    </div>
  )
}

function Option({
  title,
  hint,
  checked,
  onChange,
  disabled,
}: {
  title: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the Switch inside is the control
    <label className="flex items-center justify-between gap-6 border-b py-3 last:border-b-0">
      <span>
        <span className="block font-medium text-sm">{title}</span>
        <span className="block text-muted-foreground text-xs">{hint}</span>
      </span>
      <Switch aria-label={title} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </label>
  )
}

const RANGE_CHOICES: { value: string; label: string; ms: number }[] = [
  { value: '15m', label: 'Last 15 min', ms: 15 * 60_000 },
  { value: '1h', label: 'Last 1 hour', ms: 3_600_000 },
  { value: '6h', label: 'Last 6 hours', ms: 6 * 3_600_000 },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 3_600_000 },
  { value: '3d', label: 'Last 3 days', ms: 3 * 24 * 3_600_000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 24 * 3_600_000 },
]

/**
 * Export what is on screen: these filters, this time range. Download streams
 * the file from `/api/export` (over ~100k lines the server prepares it first,
 * with progress, see `export_jobs.rs`);
 * Copy curl mints a read-only `qx_` token for this exact query (reusable for
 * 15 minutes) and copies a ready curl.
 */
export function ExportDialog({
  open,
  onOpenChange,
  title,
  description,
  params,
  summary,
  rangeNote = 'from this view',
  fixedRange,
  fileName,
  defaultGzip = true,
  footnote,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  /** The filters being exported; `since`/`until` must be set. */
  params: SearchParams
  /** Extra rows for the summary box (source, filters…). */
  summary?: ReactNode
  /** Says where the default time range came from. */
  rangeNote?: string
  /** A fixed span (a flow): shown, not choosable. */
  fixedRange?: string
  fileName?: string
  defaultGzip?: boolean
  /** Replaces the size line (a flow says lines · steps · size). */
  footnote?: (est: { total: number | null; bytes: number | null }) => ReactNode
}) {
  const retention = useHealth().data?.retention_ms ?? 86_400_000
  const [opts, setOpts] = useState<ExportOptions>({
    format: 'ndjson',
    gzip: defaultGzip,
    mask: true,
    raw: false,
    columns: DEFAULT_COLUMNS,
  })
  const [range, setRange] = useState<string>('view')
  const [curl, setCurl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState<string | null>(null)
  const running = useJob()
  const set = (o: Partial<ExportOptions>) => {
    setOpts((p) => ({ ...p, ...o }))
    setCurl(null)
  }

  const chosen = RANGE_CHOICES.find((r) => r.value === range)
  const now = Date.now()
  const effective: SearchParams = chosen ? { ...params, since: now - chosen.ms, until: undefined } : params
  // Round "now" to the minute so the estimate isn't refetched every render.
  const keyParams = chosen ? { ...params, since: Math.floor((now - chosen.ms) / 60_000) * 60_000 } : params

  // Size estimate: count + raw bytes of what matches (one tiny search).
  const estimate = useQuery({
    queryKey: ['export-estimate', keyParams],
    queryFn: ({ signal }) =>
      fetchJson(`/api/search?${toQuery({ ...keyParams, limit: 1, buckets: 1 })}`, searchResponse, { signal }),
    enabled: open,
  })
  const total = estimate.data?.total ?? null
  const bytes = estimate.data?.bytes ?? null

  const query = exportQuery(effective, opts)
  const file = fileName ? `${fileName}.${opts.format}${opts.gzip ? '.gz' : ''}` : exportFileName(effective, opts)
  const toggleColumn = (c: string, on: boolean) =>
    set({ columns: on ? [...opts.columns.filter((x) => x !== c), c] : opts.columns.filter((x) => x !== c) })
  const moveColumn = (from: string, to: string) => {
    if (from === to) return
    const cols = opts.columns.filter((c) => c !== from)
    cols.splice(cols.indexOf(to), 0, from)
    set({ columns: cols })
  }
  const large = total != null && total > LARGE

  const onCopy = async () => {
    setBusy(true)
    try {
      const r = await copyCurl(query, file)
      await navigator.clipboard?.writeText(r.curl)
      // Show it with the secret cut down; the clipboard has the real one.
      setCurl(r.curl.replace(/qx_[0-9a-f]+/, (t) => `qx_····${t.slice(-4)}`))
      toast.success('curl copied', { description: 'Read-only token, this query only, expires in 15 min.' })
    } catch (e) {
      toast.error('Could not make a curl', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const rangeText = (p: SearchParams) =>
    p.since != null ? `${fmtClock(p.since)}–${fmtClock(p.until ?? Date.now())}` : 'whole window'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] gap-5 overflow-y-auto p-6 sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="border bg-background/40 px-3 py-1">
          {summary}
          <Row label="time range">
            {fixedRange ? (
              <span>{fixedRange}</span>
            ) : (
              <>
                <Select value={range} onValueChange={(v) => v && setRange(String(v))}>
                  <SelectTrigger aria-label="Time range" size="sm" className="h-7 min-w-56 font-mono text-xs">
                    <SelectValue>
                      {(v: string) =>
                        v === 'view'
                          ? `As shown · ${rangeText(params)}`
                          : `${RANGE_CHOICES.find((r) => r.value === v)?.label}${RANGE_CHOICES.find((r) => r.value === v)?.ms === retention ? ` · whole ${fmtWindow(retention)} window` : ` · ${rangeText(effective)}`}`
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="view">As shown · {rangeText(params)}</SelectItem>
                    {RANGE_CHOICES.filter((r) => r.ms <= retention).map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                        {r.ms === retention ? ' · whole window' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-muted-foreground">{range === 'view' ? rangeNote : 'changed in this dialog'}</span>
              </>
            )}
          </Row>
          <div className="flex items-center gap-2 py-2 font-mono text-muted-foreground text-xs">
            <InfoIcon className="size-3.5" />
            {footnote
              ? footnote({ total, bytes })
              : total == null
                ? 'Counting…'
                : `≈ ${fmtCount(total)} lines · ~${fmtBytes(bytes ?? 0)} raw${opts.gzip ? ` · ~${fmtBytes(Math.round((bytes ?? 0) / 12))} gzipped` : ''}`}
          </div>
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">Format</h3>
          <RadioGroup
            aria-label="Format"
            value={opts.format}
            onValueChange={(v) => set({ format: v as ExportFormat })}
            className="grid-cols-3"
          >
            {FORMATS.map((f) => (
              // biome-ignore lint/a11y/noLabelWithoutControl: the radio inside is the control
              <label
                key={f.value}
                className={cn(
                  'flex cursor-pointer gap-2.5 border p-3 hover:bg-accent/40',
                  opts.format === f.value && 'border-brand bg-brand/10',
                )}
              >
                <RadioGroupItem value={f.value} aria-label={f.title} className="mt-0.5" />
                <span>
                  <span className="flex items-center gap-2 font-medium text-sm">
                    {f.title}
                    {f.value === 'ndjson' && (
                      <span className="border px-1 font-mono text-[10px] text-muted-foreground">default</span>
                    )}
                  </span>
                  <span className="block text-muted-foreground text-xs">{f.hint}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </section>

        {opts.format === 'csv' && (
          <section className="flex flex-col gap-2" aria-label="Columns">
            <div className="flex items-center justify-between">
              <h3 className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
                Columns · drag to reorder
              </h3>
              <Button variant="ghost" size="xs" onClick={() => set({ columns: DEFAULT_COLUMNS })}>
                Reset to default
              </Button>
            </div>
            <ol className="flex flex-col border">
              {opts.columns.map((c, i) => (
                <li
                  key={c}
                  draggable
                  onDragStart={() => setDrag(c)}
                  onDragOver={(e) => {
                    e.preventDefault()
                    if (drag && drag !== c) moveColumn(drag, c)
                  }}
                  onDragEnd={() => setDrag(null)}
                  className={cn(
                    'flex h-8 items-center gap-2 border-border/60 border-b px-2 last:border-b-0',
                    drag === c && 'bg-brand/10',
                  )}
                >
                  <GripVerticalIcon className="size-3.5 cursor-grab text-muted-foreground" aria-hidden />
                  <span className="w-5 font-mono text-[11px] text-muted-foreground">{i + 1}</span>
                  <Checkbox checked onCheckedChange={(v) => toggleColumn(c, Boolean(v))} aria-label={c} />
                  <span className="flex-1 font-mono text-xs">{c}</span>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-3 font-mono text-muted-foreground text-xs">
              add:
              {SUGGESTED.filter((c) => !opts.columns.includes(c)).map((c) => (
                // biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is the control
                <label key={c} className="flex cursor-pointer items-center gap-1.5 hover:text-foreground">
                  <Checkbox checked={false} onCheckedChange={() => toggleColumn(c, true)} aria-label={`Add ${c}`} />
                  {c}
                </label>
              ))}
              <FieldAdder onAdd={(c) => toggleColumn(c, true)} />
            </div>
          </section>
        )}

        <section>
          <h3 className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">Options</h3>
          <Option
            title="Include raw line"
            hint={
              opts.format === 'ndjson'
                ? 'NDJSON already is the raw line.'
                : 'Adds the line exactly as received, next to its fields.'
            }
            checked={opts.raw && opts.format !== 'ndjson'}
            disabled={opts.format === 'ndjson'}
            onChange={(raw) => set({ raw })}
          />
          <Option
            title="Mask PII fields"
            hint="email, phone, name, ip_address, user_agent, plus emails and IPs inside text · on because PII masking is on for these sources."
            checked={opts.mask}
            onChange={(mask) => set({ mask })}
          />
          <Option
            title="Gzip"
            hint="Usually 10–20× smaller. The file ends in .gz."
            checked={opts.gzip}
            onChange={(gzip) => set({ gzip })}
          />
        </section>

        {curl && (
          <section className="flex flex-col gap-2">
            <p className="flex items-center gap-1.5 font-mono text-status-ok text-xs">
              <CheckIcon className="size-3.5" /> curl copied
              <span className="text-muted-foreground">
                · qx_ token: read-only, this query only, reusable, expires in 15 min
              </span>
            </p>
            <pre
              data-testid="curl"
              className="overflow-x-auto whitespace-pre-wrap break-all border bg-background p-3 font-mono text-xs"
            >
              {curl}
            </pre>
          </section>
        )}

        {running && <Progress j={running} />}

        <footer className="flex items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-mono text-muted-foreground text-xs">
            <FileDownIcon className="size-3.5 shrink-0" />
            {running ? running.file : file}
          </span>
          {running ? (
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onCopy} disabled={busy}>
              {curl ? <CheckIcon /> : <TerminalIcon />}
              {curl ? 'Copied' : 'Copy curl'}
            </Button>
          )}
          {running ? (
            <Button
              size="sm"
              disabled={!running.ready}
              onClick={() => {
                downloadJob(running.id, running.file)
                job = null
                emit()
              }}
            >
              <FileDownIcon />
              Download
              <CornerDownLeftIcon className="ml-1 size-3 opacity-60" />
            </Button>
          ) : large ? (
            <Button size="sm" onClick={() => runServerExport(query)}>
              <FileDownIcon />
              Download
              <CornerDownLeftIcon className="ml-1 size-3 opacity-60" />
            </Button>
          ) : (
            <Button
              size="sm"
              nativeButton={false}
              render={<a href={`/api/export?${query}`} download={file} aria-label="Download" />}
              onClick={() => onOpenChange(false)}
            >
              <FileDownIcon />
              Download
              <CornerDownLeftIcon className="ml-1 size-3 opacity-60" />
            </Button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  )
}

/** "+ Field…": type any field path (dot paths work, e.g. `err.code`). */
function FieldAdder({ onAdd }: { onAdd: (c: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState('')
  if (!editing)
    return (
      <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
        <PlusIcon />
        Field…
      </Button>
    )
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: opened on purpose by the user
      autoFocus
      aria-label="Field path"
      placeholder="field.path"
      className="h-6 w-32 border bg-transparent px-1.5 font-mono text-xs outline-none focus:border-ring"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && v.trim()) {
          onAdd(v.trim())
          setV('')
          setEditing(false)
        }
        if (e.key === 'Escape') setEditing(false)
      }}
    />
  )
}
