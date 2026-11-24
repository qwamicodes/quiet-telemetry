import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { useNavigate } from '@tanstack/react-router'
import { XIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Marker } from '@/components/whats-new/marker'
import { useSources } from '@/lib/api'
import {
  CHANGELOG_URL,
  CHANGES,
  type Change,
  PREVIOUS,
  RELEASE,
  RELEASED,
  useWhatsNew,
  useWhatsNewOpen,
} from '@/lib/whats-new'

/** The 64px marker lane: rows line up whether or not a change is still unseen. */
function Lane({ kind, unseen, className }: { kind: Change['kind']; unseen: boolean; className?: string }) {
  return <span className={`flex w-16 shrink-0 ${className ?? ''}`}>{unseen && <Marker kind={kind} />}</span>
}

function Heading({ title, aside, className }: { title: string; aside: string; className?: string }) {
  return (
    <div
      className={`flex items-baseline justify-between font-mono text-[11px] text-muted-foreground leading-3.5 ${className ?? ''}`}
    >
      <h3 className="uppercase tracking-[0.06em]">{title}</h3>
      <span>{aside}</span>
    </div>
  )
}

const List = ({ children, label }: { children: ReactNode; label: string }) => (
  <ul aria-label={label} className="flex flex-col border">
    {children}
  </ul>
)

/** What's new (v0.1.1-00.2): changes to your logs, old-format sources, changes to quiet. */
export function WhatsNewSheet() {
  const [open, setOpen] = useWhatsNewOpen()
  const w = useWhatsNew()
  const navigate = useNavigate()
  const unseen = new Set(w.unseen.map((c) => c.id))
  const old = (useSources().data ?? []).filter((s) => s.format === 'v0.1.0')
  const logs = CHANGES.filter((c) => c.area === 'logs')
  const app = CHANGES.filter((c) => c.area === 'app')

  const openChange = (c: Change) => {
    if (!c.open) return
    w.markSeen([c.id])
    setOpen(false)
    if (c.open.to === '/guide') navigate({ to: '/guide', search: { tab: c.open.tab } })
    else navigate({ to: '/' })
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent width={560} className="bg-popover" aria-describedby={undefined}>
        <div className="flex shrink-0 items-start gap-3 border-b px-6 pt-5 pb-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <DialogPrimitive.Title className="font-semibold text-xl leading-6.5 tracking-tight">
              What's new in v{RELEASE}
            </DialogPrimitive.Title>
            <span className="font-mono text-muted-foreground text-xs leading-4">
              {RELEASED} · upgraded from v{PREVIOUS} · {CHANGES.length} changes
            </span>
          </div>
          <DialogPrimitive.Close render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}>
            <XIcon />
          </DialogPrimitive.Close>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-5">
          <Heading title="Changes to your logs" aside="affects code you already wrote" />
          <List label="Changes to your logs">
            {logs.map((c) => (
              <li key={c.id} className="flex items-start gap-3 border-b px-3.5 py-3 last:border-b-0">
                <Lane kind={c.kind} unseen={unseen.has(c.id)} className="pt-0.5" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="font-medium text-foreground text-sm leading-5">{c.title}</span>
                  {c.fields && <span className="font-mono text-muted-foreground text-xs leading-4.5">{c.fields}</span>}
                  {c.summary && <span className="text-muted-foreground text-xs leading-4">{c.summary}</span>}
                </div>
              </li>
            ))}
          </List>

          {old.length > 0 && (
            <div className="flex items-center gap-3 border-status-warn border-l-2 bg-level-warn-muted px-3.5 py-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-[13px] text-foreground leading-4.5">
                  {old.length === 1 ? '1 source still logs' : `${old.length} sources still log`} in the v{PREVIOUS}{' '}
                  format
                </span>
                <span className="truncate font-mono text-muted-foreground text-xs leading-4">
                  {old.map((s) => s.display_name ?? s.name).join(' · ')}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setOpen(false)
                  navigate({ to: '/sources/$name/upgrade', params: { name: old[0].name } })
                }}
              >
                {old.length === 1 ? `Upgrade ${old[0].display_name ?? old[0].name}` : 'Upgrade a source'}
              </Button>
            </div>
          )}

          <Heading title="Changes to quiet" aside="no action needed" className="pt-3" />
          <List label="Changes to quiet">
            {app.map((c) => (
              <li key={c.id} className="border-b last:border-b-0">
                <button
                  type="button"
                  onClick={() => openChange(c)}
                  className="flex h-9 w-full items-center gap-3 px-3.5 text-left outline-none hover:bg-accent focus-visible:bg-accent"
                >
                  <Lane kind={c.kind} unseen={unseen.has(c.id)} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground leading-4.5">{c.title}</span>
                  {c.open && (
                    <span className="font-mono text-[11px] text-muted-foreground leading-3.5">{c.open.label} →</span>
                  )}
                </button>
              </li>
            ))}
          </List>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t px-6 py-3.5">
          <span className="min-w-0 flex-1 text-muted-foreground text-xs leading-4">
            Markers clear when you open each change, or at the next version.
          </span>
          <Button variant="outline" size="sm" render={<a href={CHANGELOG_URL} target="_blank" rel="noreferrer" />}>
            Full changelog
          </Button>
          <Button size="sm" onClick={w.markAllSeen} disabled={!w.active || w.unseen.length === 0}>
            Mark all as seen
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
