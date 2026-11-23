import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'

const GROUPS: { title: string; rows: [string, string[]][] }[] = [
  {
    title: 'Stream',
    rows: [
      ['pause / resume', ['space']],
      ['jump to newest', ['G']],
      ['move between lines', ['J', 'K']],
      ['open flow', ['↵']],
      ['open the line as a diagram', ['D']],
      ['mute the line (route, this source)', ['M']],
      ['mute menu · 1 2 3 pick · tab scope', ['⇧', 'M']],
      ['copy the line', ['C']],
      ['undo the last mute (toast up)', ['⌘', 'Z']],
      ['preview the selected line', ['space']],
      ['filter', ['/']],
      ['errors only', ['E']],
      ['toggle debug · info · warn · error', ['1', '2', '3', '4']],
      ['clear filters', ['X']],
    ],
  },
  {
    title: 'Flow + card',
    rows: [
      ['previous / next step', ['J', 'K']],
      ['Fields · JSON · Raw', ['tab']],
      ['copy line as JSON', ['C']],
      ['filter stream by value', ['F']],
      ['open in stream', ['O']],
      ['back to stream', ['esc']],
      ['diagram: search · fit · zoom', ['/', '0', '+', '−']],
      ['diagram: back to card', ['esc']],
    ],
  },
  {
    title: 'Anywhere',
    rows: [
      ['command palette', ['⌘', 'K']],
      ['search 24h', ['⌘', '/']],
      ['sources', ['S']],
      ['toggle theme', ['T']],
      ['hide / show the sidebar', ['⌘', 'B']],
      ['Open guide', ['G', 'H']],
      ['Copy agent prompt', ['⌘', '⇧', 'C']],
      ['Check my logs', ['G', 'L']],
      ['this sheet', ['?']],
    ],
  },
]

/** `?`: every keyboard shortcut (design 08.2). */
export function ShortcutsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 p-6 sm:max-w-[840px]">
        <DialogHeader className="flex-row items-center justify-between pr-8">
          <DialogTitle className="text-base">Keyboard shortcuts</DialogTitle>
          <DialogDescription className="flex items-center gap-1.5 text-xs">
            press <Kbd className="border bg-transparent font-mono">?</Kbd> anytime
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-6">
          {GROUPS.map((g) => (
            <section key={g.title} aria-label={g.title}>
              <h3 className="pb-2 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
                {g.title}
              </h3>
              <ul>
                {g.rows.map(([label, keys]) => (
                  <li
                    key={label}
                    className="flex min-h-8 items-center justify-between gap-3 border-border/60 border-b py-1 text-[13px] leading-tight"
                  >
                    <span className="min-w-0 text-muted-foreground">{label}</span>
                    <span className="flex shrink-0 gap-1">
                      {keys.map((k) => (
                        <Kbd key={k} className="border bg-transparent font-mono">
                          {k}
                        </Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
