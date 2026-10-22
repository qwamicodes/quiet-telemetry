import { ChevronDownIcon, ChevronUpIcon, CopyIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { LevelBadge } from '@/components/level-badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { LogLine } from '@/gen'
import { bytes, fmtTime } from '@/lib/format'
import { toast } from '@/lib/toast'
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

/** Slice 1 card: one line's fields, JSON and raw text. The flow view wraps this in slice 3. */
export function FieldCard({
  line,
  position,
  onClose,
  onPrev,
  onNext,
}: {
  line: LogLine
  position: { index: number; total: number }
  onClose: () => void
  onPrev: () => void
  onNext: () => void
}) {
  const [tab, setTab] = useState<Tab>(line.fields ? 'fields' : 'raw')
  const active: Tab = !line.fields && tab !== 'raw' ? 'raw' : tab
  const json = line.fields ? JSON.stringify(line.fields, null, 2) : ''
  const bad = line.level === 'error' || line.level === 'fatal'

  return (
    <section aria-label="Line details" className="flex min-h-0 w-100 shrink-0 flex-col border bg-card">
      <header className="flex flex-col gap-2 border-b p-4">
        <div className="flex items-start gap-2">
          <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', bad ? 'bg-status-err' : 'bg-brand')} />
          <h2 className="line-clamp-2 flex-1 break-all font-medium font-mono text-[13px]">{line.msg}</h2>
          <IconButton label="Copy raw line" onClick={() => copy(line.raw, 'raw line')}>
            <CopyIcon />
          </IconButton>
          <IconButton label="Close (esc)" onClick={onClose}>
            <XIcon />
          </IconButton>
        </div>
        <div className="flex items-center gap-2 font-mono text-muted-foreground text-xs">
          <LevelBadge level={line.level} />
          <span title={new Date(line.ts).toISOString()}>{fmtTime(line.ts)}</span>
          <span>· {line.source}</span>
          <span className="flex-1" />
          <span className="tabular-nums">
            {position.index + 1} / {position.total}
          </span>
          <IconButton label="Previous (k)" onClick={onPrev}>
            <ChevronUpIcon />
          </IconButton>
          <IconButton label="Next (j)" onClick={onNext}>
            <ChevronDownIcon />
          </IconButton>
        </div>
        {line.ids.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {line.ids.map((i) => (
              <span key={i.key + i.value} className="border px-1.5 py-0.5 font-mono text-[11px]">
                <span className="text-muted-foreground">{i.key}</span> {i.value}
              </span>
            ))}
          </div>
        )}
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
          <span className="font-mono text-[11px] text-muted-foreground">{bytes(line.raw)} B</span>
        </div>
        <TabsContent value="fields" className="min-h-0 overflow-y-auto">
          {line.fields && (
            <dl className="font-mono text-xs">
              {flatten(line.fields).map(([k, v]) => (
                <div
                  key={k}
                  className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 border-b border-border/60 py-1.5"
                >
                  <dt className="truncate text-syntax-key" title={k}>
                    {k}
                  </dt>
                  <dd className="break-all">
                    <Value v={v} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </TabsContent>
        <TabsContent value="json" className="min-h-0 overflow-auto">
          <pre className="bg-code p-3 font-mono text-xs leading-relaxed">{json}</pre>
        </TabsContent>
        <TabsContent value="raw" className="min-h-0 overflow-auto">
          <pre className="whitespace-pre-wrap break-all bg-code p-3 font-mono text-xs leading-relaxed">{line.raw}</pre>
          <dl className="mt-3 font-mono text-xs">
            <div className="grid grid-cols-[96px_1fr] border-b border-border/60 py-1.5">
              <dt className="text-syntax-key">received</dt>
              <dd>
                {fmtTime(line.received)} · {line.received - line.ts >= 0 ? '+' : ''}
                {line.received - line.ts}ms
              </dd>
            </div>
            <div className="grid grid-cols-[96px_1fr] border-b border-border/60 py-1.5">
              <dt className="text-syntax-key">parsed</dt>
              <dd>{line.fields ? `json · ${Object.keys(line.fields).length} keys` : 'text'}</dd>
            </div>
          </dl>
        </TabsContent>
      </Tabs>
    </section>
  )
}
