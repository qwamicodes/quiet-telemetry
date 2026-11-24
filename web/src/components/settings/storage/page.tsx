import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { ReadOnlyNote } from '@/components/settings/kit'
import { LocalStorage } from '@/components/settings/storage'
import { Connectors } from '@/components/settings/storage/connectors'
import { Overview } from '@/components/settings/storage/overview'
import { PolicyTab } from '@/components/settings/storage/policy'
import { isOwner, useMe } from '@/lib/auth-api'
import type { StorageSearch } from '@/lib/search-params'
import { cn } from '@/lib/utils'

// Settings → Storage (v1.1-01…18, 25, 28, 29): Overview · Connectors · Policy.
// Sub-views (add, connect, details, edit, local settings) live in the URL so
// Back and shared links work.

export type Go = (s: StorageSearch) => void

export function useStorageNav(): [StorageSearch, Go] {
  const search = useSearch({ from: '/settings/storage' }) as StorageSearch
  const navigate = useNavigate()
  return [search, (s) => navigate({ to: '/settings/storage', search: s })]
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'policy', label: 'Policy' },
] as const

export function StorageTabs({ tab }: { tab: StorageSearch['tab'] }) {
  const current = tab ?? 'overview'
  return (
    <nav aria-label="Storage" className="flex items-center gap-6 border-b">
      {TABS.map((t) => (
        <Link
          key={t.id}
          to="/settings/storage"
          search={t.id === 'overview' ? {} : { tab: t.id }}
          aria-current={current === t.id ? 'page' : undefined}
          className={cn(
            '-mb-px border-transparent border-b-2 pb-2.5 text-xs leading-[18px] outline-none focus-visible:text-foreground',
            current === t.id ? 'border-brand text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}

/** `Storage / Connectors / Add connector`. */
export function Crumbs({ items }: { items: { label: string; to?: StorageSearch }[] }) {
  return (
    <p className="flex items-center gap-2 font-mono text-muted-foreground text-xs leading-[18px]">
      {items.map((c, i) => (
        <span key={c.label} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden>/</span>}
          {c.to ? (
            <Link to="/settings/storage" search={c.to} className="hover:text-foreground">
              {c.label}
            </Link>
          ) : (
            <span>{c.label}</span>
          )}
        </span>
      ))}
    </p>
  )
}

/** The page frame: header (from the view), tabs, then the view's body. */
export function StorageFrame({
  header,
  tab,
  children,
}: {
  header: ReactNode
  tab: StorageSearch['tab']
  children: ReactNode
}) {
  const owner = isOwner(useMe())
  return (
    <div className="flex max-w-190 flex-col gap-5">
      {header}
      <StorageTabs tab={tab} />
      {!owner && <ReadOnlyNote />}
      {children}
    </div>
  )
}

export function StoragePage() {
  const [search] = useStorageNav()
  if (search.screen === 'local') {
    return (
      <LocalStorage
        crumb={
          <Crumbs items={[{ label: 'Storage', to: {} }, { label: 'Overview', to: {} }, { label: 'Local settings' }]} />
        }
      />
    )
  }
  if (search.tab === 'connectors') return <Connectors />
  if (search.tab === 'policy') return <PolicyTab />
  return <Overview />
}
