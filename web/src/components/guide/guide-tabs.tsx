import { Link } from '@tanstack/react-router'
import { Marker } from '@/components/whats-new/marker'
import type { GuideSearch, GuideTab } from '@/lib/search-params'
import { cn } from '@/lib/utils'
import { type Target, useWhatsNew } from '@/lib/whats-new'

export const GUIDE_TABS: { id: GuideTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'agent', label: 'Instrument with an agent' },
  { id: 'canonical', label: 'The canonical line' },
  { id: 'ids', label: 'Ids & flows' },
  { id: 'check', label: 'Check my logs' },
]

/** `new` / `updated` on a Guide tab until it is opened (v0.1.1-00.1). */
function GuideTabMarker({ tab }: { tab: GuideTab }) {
  const kind = useWhatsNew().marker(`guide.${tab}` as Target)
  return kind && tab !== 'overview' ? <Marker kind={kind} /> : null
}

/** The Guide's line tabs; the upgrade screen (00.3) shows them with Check my logs active. */
export function GuideTabs({ active, search = {} }: { active: GuideTab; search?: GuideSearch }) {
  return (
    <nav aria-label="Guide sections" className="flex items-end gap-1 border-b">
      {GUIDE_TABS.map((t) => (
        <Link
          key={t.id}
          to="/guide"
          search={{ ...search, tab: t.id === 'overview' ? undefined : t.id }}
          aria-current={t.id === active ? 'page' : undefined}
          className={cn(
            '-mb-px flex h-8 items-center gap-1.5 border-transparent border-b-2 px-2.5 font-medium text-muted-foreground text-xs hover:text-foreground',
            t.id === active && 'border-foreground text-foreground',
          )}
        >
          {t.label}
          <GuideTabMarker tab={t.id} />
        </Link>
      ))}
    </nav>
  )
}
