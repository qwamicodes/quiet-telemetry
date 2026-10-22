import { useQuery } from '@tanstack/react-query'
import { CheckIcon, CornerDownLeftIcon, DownloadIcon, InfoIcon, PlusIcon, TerminalIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import type { ExportFormat, SearchParams } from '@/gen'
import { fetchJson } from '@/lib/api'
import { fmtBytes, fmtClock, fmtCount } from '@/lib/format'
import { searchResponse } from '@/lib/schemas'
import { copyCurl, type ExportOptions, exportFileName, exportQuery, toQuery } from '@/lib/search-api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

/** CSV columns on by default, and the ones offered to add (design 05.5). */
export const DEFAULT_COLUMNS = ['timestamp', 'level', 'source', 'request_id', 'msg', 'status', 'duration_ms']
const SUGGESTED = ['job_id', 'method', 'path', 'user_id', 'error.message']

const FORMATS: { value: ExportFormat; title: string; hint: string }[] = [
  { value: 'ndjson', title: 'NDJSON', hint: 'Raw lines exactly as received, one per line.' },
  { value: 'json', title: 'JSON array', hint: 'One array of parsed lines with their fields.' },
  { value: 'csv', title: 'CSV', hint: 'Pick columns. Opens in any spreadsheet.' },
]

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

/**
 * Export what is on screen: these filters, this time range. Download streams
 * the file from `/api/export`; Copy curl mints a read-only `qx_` token for this
 * exact query (reusable for 15 minutes) and copies a ready curl.
 */
export function ExportDialog({
  open,
  onOpenChange,
  title,
  description,
  params,
  summary,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  /** The filters being exported; `since`/`until` must be set. */
  params: SearchParams
  /** Extra rows for the summary box (source, filters…). */
  summary?: ReactNode
}) {
  const [opts, setOpts] = useState<ExportOptions>({
    format: 'ndjson',
    gzip: true,
    mask: true,
    raw: false,
    columns: DEFAULT_COLUMNS,
  })
  const [curl, setCurl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (o: Partial<ExportOptions>) => {
    setOpts((p) => ({ ...p, ...o }))
    setCurl(null)
  }

  // Size estimate: count + raw bytes of what matches (one tiny search).
  const estimate = useQuery({
    queryKey: ['export-estimate', params],
    queryFn: ({ signal }) =>
      fetchJson(`/api/search?${toQuery({ ...params, limit: 1, buckets: 1 })}`, searchResponse, { signal }),
    enabled: open,
  })
  const total = estimate.data?.total ?? null
  const bytes = estimate.data?.bytes ?? null

  const query = exportQuery(params, opts)
  const file = exportFileName(params, opts)
  const toggleColumn = (c: string, on: boolean) =>
    set({ columns: on ? [...opts.columns.filter((x) => x !== c), c] : opts.columns.filter((x) => x !== c) })

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 p-6 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="border bg-background/40 px-3 py-1">
          {summary}
          <Row label="time range">
            {params.since != null && params.until != null
              ? `${fmtClock(params.since)}–${fmtClock(params.until)}`
              : 'whole window'}
          </Row>
          <div className="flex items-center gap-2 py-2 font-mono text-muted-foreground text-xs">
            <InfoIcon className="size-3.5" />
            {total == null
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
                Columns · in this order
              </h3>
              <Button variant="ghost" size="xs" onClick={() => set({ columns: DEFAULT_COLUMNS })}>
                Reset to default
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {opts.columns.map((c) => (
                // biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is the control
                <label key={c} className="flex items-center gap-1.5 border border-brand/40 bg-brand/10 px-2 py-1">
                  <Checkbox checked onCheckedChange={(v) => toggleColumn(c, v)} aria-label={c} />
                  <span className="font-mono text-xs">{c}</span>
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-muted-foreground text-xs">
              add:
              {SUGGESTED.filter((c) => !opts.columns.includes(c)).map((c) => (
                <Button key={c} variant="outline" size="xs" className="font-mono" onClick={() => toggleColumn(c, true)}>
                  <PlusIcon />
                  {c}
                </Button>
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
            hint="email, phone, name, ip_address, user_agent, plus emails and IPs inside text."
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

        <footer className="flex items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-mono text-muted-foreground text-xs">
            <DownloadIcon className="size-3.5 shrink-0" />
            {file}
          </span>
          <Button variant="outline" size="sm" onClick={onCopy} disabled={busy}>
            {curl ? <CheckIcon /> : <TerminalIcon />}
            {curl ? 'Copied' : 'Copy curl'}
          </Button>
          <Button
            size="sm"
            nativeButton={false}
            render={<a href={`/api/export?${query}`} download={file} aria-label="Download" />}
            onClick={() => onOpenChange(false)}
          >
            <DownloadIcon />
            Download
            <CornerDownLeftIcon className="ml-1 size-3 opacity-60" />
          </Button>
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
