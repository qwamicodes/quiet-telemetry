import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  CornerDownLeftIcon,
  GitForkIcon,
  KeyboardIcon,
  MoonIcon,
  PauseIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
} from 'lucide-react'
import { useState } from 'react'
import { GroupIcon } from '@/components/source-group-header'
import { StatusDot } from '@/components/status-dot'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import type { CorrId, SourceInfo } from '@/gen'
import { fetchJson, useSources } from '@/lib/api'
import { kindLabel } from '@/lib/connect'
import { useFlowSummaries } from '@/lib/flow-api'
import { fmtClock, isRecent } from '@/lib/format'
import { searchResponse } from '@/lib/schemas'
import { groupSources, KIND_TAG } from '@/lib/source-groups'
import { useTheme } from '@/lib/theme'
import { useDebounced } from '@/lib/use-debounced'
import { useRates } from '@/lib/use-rates'

/** The stream listens for this to pause/resume from the palette. */
export const TOGGLE_PAUSE = 'quiet:toggle-pause'

/** Ids seen in recent lines that start with (or contain) what was typed. */
function useIdMatches(q: string) {
  return useQuery({
    queryKey: ['palette-ids', q],
    enabled: q.length >= 3,
    staleTime: 10_000,
    queryFn: async ({ signal }) => {
      const r = await fetchJson(`/api/search?q=${encodeURIComponent(q)}&limit=200`, searchResponse, { signal })
      const seen = new Map<string, { id: CorrId; ts: number }>()
      for (const l of r.lines)
        for (const id of l.ids)
          if (id.value.toLowerCase().includes(q.toLowerCase()) && !seen.has(id.value))
            seen.set(id.value, { id, ts: l.ts })
      return [...seen.values()].slice(0, 5)
    },
  })
}

/** ⌘K: jump to a source, open a flow by id, or run an action (design 08.1). */
export function CommandPalette({
  open,
  onOpenChange,
  onOpenShortcuts,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenShortcuts?: () => void
}) {
  const sources = useSources().data ?? []
  const rates = useRates(sources)
  const navigate = useNavigate()
  const { theme, toggle } = useTheme()
  const [query, setQuery] = useState('')
  const id = query.trim()
  const settled = useDebounced(id, 200)
  const matches = useIdMatches(open ? settled : '').data ?? []
  const summaries = useFlowSummaries(matches.map((m) => m.id.value))
  const onStream = typeof window !== 'undefined' && window.location.pathname === '/'

  // Sources under their group (board v0.1-03.9); a group opens Sources filtered, it never streams.
  const grouped = groupSources(sources, sources)
  const sourceItem = (s: SourceInfo) => {
    const rate = rates[s.name]
    const live = isRecent(s.last_ts)
    return (
      <CommandItem
        key={s.name}
        value={`source ${s.name} ${s.display_name ?? ''} ${s.kind} ${s.group ?? ''}`}
        onSelect={() => run(() => navigate({ to: '/', search: { source: s.name } }))}
      >
        <StatusDot status={s.paused ? 'warn' : live ? 'ok' : 'idle'} />
        <span className="font-mono">{s.display_name ?? s.name}</span>
        <span className="font-mono text-muted-foreground text-xs">
          {kindLabel(s.kind)} ·{' '}
          {s.paused ? 'paused' : live && rate ? `${rate < 10 ? rate.toFixed(1) : Math.round(rate)} lines/s` : 'idle'}
        </span>
      </CommandItem>
    )
  }

  const run = (fn: () => void) => {
    onOpenChange(false)
    setQuery('')
    fn()
  }
  const searchAll = () => run(() => navigate({ to: '/search', search: { q: id || undefined, range: '24h' } }))

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Jump to"
      description="Sources, flow ids and actions"
      className="sm:max-w-xl"
    >
      <Command>
        <div className="relative">
          <CommandInput
            placeholder="Jump to a source, paste an id…"
            value={query}
            onValueChange={setQuery}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                searchAll()
              }
            }}
          />
          <span className="pointer-events-none absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-2 font-mono text-[11px] text-muted-foreground">
            sources, flow ids, actions <Kbd>esc</Kbd>
          </span>
        </div>
        <CommandList className="max-h-[28rem]">
          <CommandEmpty>Nothing matches.</CommandEmpty>
          {grouped.length === 0 && sources.length > 0 && (
            <CommandGroup heading="Sources">{sources.map(sourceItem)}</CommandGroup>
          )}
          {grouped.map((g, i) => (
            <CommandGroup
              key={g.key}
              heading={
                <span className="flex items-center gap-1.5">
                  {i === 0 && <span className="sr-only">Sources · </span>}
                  <GroupIcon kind={g.kind} className="size-3" />
                  <span className="font-mono normal-case tracking-normal">{g.name}</span>
                </span>
              }
            >
              {g.rows.map(sourceItem)}
            </CommandGroup>
          ))}
          {grouped.length > 0 && (
            <CommandGroup heading="Groups">
              {grouped.map((g) => (
                <CommandItem
                  key={g.key}
                  value={`group ${g.name} ${g.rows.map((s) => s.name).join(' ')}`}
                  onSelect={() => run(() => navigate({ to: '/sources', search: { group: g.key } }))}
                >
                  <GroupIcon kind={g.kind} />
                  <span className="font-mono">{g.name}</span>
                  <span className="font-mono text-muted-foreground text-xs">
                    {KIND_TAG[g.kind]} · {g.sending}/{g.total} sending
                  </span>
                  <CommandShortcut className="tracking-normal">show on Sources</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {id.length >= 3 && (
            <CommandGroup heading="Flows by id" forceMount>
              {matches
                .filter((m) => m.id.value !== id)
                .map((m) => {
                  const f = summaries.get(m.id.value)
                  return (
                    <CommandItem
                      key={m.id.value}
                      value={`flow ${m.id.value} ${id}`}
                      forceMount
                      onSelect={() => run(() => navigate({ to: '/flow/$id', params: { id: m.id.value } }))}
                    >
                      <GitForkIcon />
                      <span className="font-mono">{m.id.value}</span>
                      <span className="truncate text-muted-foreground text-xs">
                        {f ? `${f.title} · ${f.status === 'error' ? 'failed' : f.status} · ` : ''}
                        {fmtClock(m.ts)}
                      </span>
                      <CommandShortcut className="border px-1 font-mono text-[10px] tracking-normal">
                        {m.id.key}
                      </CommandShortcut>
                    </CommandItem>
                  )
                })}
              <CommandItem
                value={`flow ${id}`}
                forceMount
                onSelect={() => run(() => navigate({ to: '/flow/$id', params: { id } }))}
              >
                <GitForkIcon />
                <span className="font-mono">{id}</span>
                <CommandShortcut>open flow</CommandShortcut>
              </CommandItem>
            </CommandGroup>
          )}
          <CommandGroup heading="Actions">
            <CommandItem value={`search last 24h ${id}`} forceMount={id.length > 0} onSelect={searchAll}>
              <SearchIcon />
              {id ? <>Search last 24h for “{id}”</> : 'Search last 24h'}
              <CommandShortcut>⌘↵</CommandShortcut>
            </CommandItem>
            {id.length > 0 &&
              grouped
                .filter((g) => g.kind !== 'ingest' && g.kind !== 'standalone')
                .map((g) => (
                  <CommandItem
                    key={`search-${g.key}`}
                    value={`search group ${g.name} ${g.rows.map((s) => s.name).join(' ')}`}
                    onSelect={() =>
                      run(() =>
                        navigate({
                          to: '/search',
                          search: { source: g.rows.map((s) => s.name).join(','), range: '24h' },
                        }),
                      )
                    }
                  >
                    <SearchIcon />
                    Search {g.name} · 24h
                    <span className="font-mono text-muted-foreground text-xs">
                      {g.total} {g.total === 1 ? 'source' : 'sources'}
                    </span>
                  </CommandItem>
                ))}
            {onStream && (
              <CommandItem
                value="pause stream resume"
                onSelect={() => run(() => window.dispatchEvent(new Event(TOGGLE_PAUSE)))}
              >
                <PauseIcon />
                Pause stream
                <CommandShortcut>space</CommandShortcut>
              </CommandItem>
            )}
            <CommandItem value="connect a source" onSelect={() => run(() => navigate({ to: '/connect' }))}>
              <PlusIcon />
              Connect a source
            </CommandItem>
            <CommandItem value="switch theme light dark" onSelect={() => run(toggle)}>
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
              Switch to {theme === 'dark' ? 'light' : 'dark'} theme
              <CommandShortcut>T</CommandShortcut>
            </CommandItem>
            {onOpenShortcuts && (
              <CommandItem value="keyboard shortcuts help" onSelect={() => run(onOpenShortcuts)}>
                <KeyboardIcon />
                Keyboard shortcuts
                <CommandShortcut>?</CommandShortcut>
              </CommandItem>
            )}
            <CommandItem value="settings" onSelect={() => run(() => navigate({ to: '/settings' }))}>
              <SettingsIcon />
              Settings
            </CommandItem>
          </CommandGroup>
        </CommandList>
        <div className="flex items-center justify-between border-t px-3 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> move{' '}
            <Kbd className="ml-2">
              <CornerDownLeftIcon />
            </Kbd>{' '}
            open
          </span>
          <span>tip: paste any id to jump straight to its flow</span>
        </div>
      </Command>
    </CommandDialog>
  )
}
