import { Link } from '@tanstack/react-router'
import { ArrowRightIcon, TriangleAlertIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader } from '@/components/ui/sheet'
import { Marker } from '@/components/whats-new/marker'
import { useSources } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CHANGES, type Change, RELEASE, useWhatsNew, useWhatsNewOpen } from '@/lib/whats-new'

function Item({ c, unseen }: { c: Change; unseen: boolean }) {
  return (
    <li className="flex flex-col gap-1 border-border/60 border-b py-3 last:border-b-0">
      <span className="flex items-center gap-2">
        <span className={cn('text-[13px]', unseen ? 'font-medium text-foreground' : 'text-muted-foreground')}>
          {c.title}
        </span>
        {unseen && <Marker kind={c.kind} />}
      </span>
      <span className="text-muted-foreground text-xs leading-5">{c.summary}</span>
    </li>
  )
}

function Section({ title, items, unseen }: { title: string; items: Change[]; unseen: Set<string> }) {
  return (
    <section aria-label={title} className="flex flex-col">
      <h3 className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">{title}</h3>
      <ul className="flex flex-col">
        {items.map((c) => (
          <Item key={c.id} c={c} unseen={unseen.has(c.id)} />
        ))}
      </ul>
    </section>
  )
}

/** What's new (v0.1.1-00.2): changes to your logs, old-format sources, changes to quiet. */
export function WhatsNewSheet() {
  const [open, setOpen] = useWhatsNewOpen()
  const w = useWhatsNew()
  const unseen = new Set(w.unseen.map((c) => c.id))
  const old = (useSources().data ?? []).filter((s) => s.format === 'v0.1.0')
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent width={480} aria-describedby={undefined}>
        <SheetHeader title="What's new" aside={`v${RELEASE}`} />
        <SheetBody className="flex flex-col gap-6">
          <p className="text-muted-foreground text-xs leading-5">
            Logs you already send keep working. These are the changes in v{RELEASE}; markers clear as you open each
            screen.
          </p>
          <Section title="Changes to your logs" items={CHANGES.filter((c) => c.area === 'logs')} unseen={unseen} />
          {old.length > 0 && (
            <div className="flex flex-col gap-2 border border-status-warn/40 bg-status-warn/5 px-3 py-2.5">
              <span className="flex items-center gap-2 text-[13px] text-foreground [&_svg]:size-3.5 [&_svg]:text-status-warn">
                <TriangleAlertIcon />
                {old.length === 1 ? '1 source still uses' : `${old.length} sources still use`} the v0.1.0 format
              </span>
              <ul className="flex flex-col gap-1">
                {old.map((s) => (
                  <li key={s.name}>
                    <Link
                      to="/sources/$name/upgrade"
                      params={{ name: s.name }}
                      onClick={() => setOpen(false)}
                      className="inline-flex items-center gap-1 font-mono text-brand text-xs hover:underline [&_svg]:size-3"
                    >
                      Upgrade {s.display_name ?? s.name} <ArrowRightIcon />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Section title="Changes to quiet" items={CHANGES.filter((c) => c.area === 'app')} unseen={unseen} />
        </SheetBody>
        <SheetFooter>
          <span className="flex-1 font-mono text-[11px] text-muted-foreground">
            {w.active ? `${w.unseen.length} unseen` : 'seen state is kept per account'}
          </span>
          {w.active && w.unseen.length > 0 && (
            <Button variant="outline" size="sm" onClick={w.markAllSeen}>
              Mark all as seen
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
