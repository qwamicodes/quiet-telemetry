import { useNavigate } from '@tanstack/react-router'
import { CheckIcon, ChevronsUpDownIcon, CornerDownLeftIcon, SearchIcon } from 'lucide-react'
import { type KeyboardEvent, useMemo, useState } from 'react'
import { SourceGroupHeader } from '@/components/source-group-header'
import { StatusDot } from '@/components/status-dot'
import { Kbd } from '@/components/ui/kbd'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { SourceInfo } from '@/gen'
import { useSources } from '@/lib/api'
import { groupOf, groupSources, type SourceGroup, sourceStatus, useCollapsedGroups } from '@/lib/source-groups'
import { useCustomGroups } from '@/lib/source-groups-api'
import { useRates } from '@/lib/use-rates'
import { cn } from '@/lib/utils'

const fmtRate = (r: number | undefined) => (!r ? '—' : r < 1 ? '<1/s' : `${Math.round(r)}/s`)

type Item = { type: 'group'; group: SourceGroup } | { type: 'source'; source: SourceInfo; nested: boolean }

/**
 * The stream top bar's source name, as a picker (board v0.1-03.8): sources by
 * group, fold with ← →, ↵ streams one source. A group never streams.
 */
export function SourcePicker({ source, name }: { source: SourceInfo | undefined; name: string | null }) {
  const sources = useSources().data ?? []
  const rates = useRates(sources)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [active, setActive] = useState(0)
  const { isCollapsed, set } = useCollapsedGroups()
  const listed = sources.filter((s) => !s.hidden || s.name === name)
  const q = text.trim().toLowerCase()
  const shown = q
    ? listed.filter((s) => `${s.name} ${s.display_name ?? ''} ${s.group ?? ''}`.toLowerCase().includes(q))
    : listed
  const custom = useCustomGroups()
  const groups = groupSources(listed, shown, undefined, custom)
  const items: Item[] = useMemo(() => {
    if (groups.length === 0) return shown.map((s) => ({ type: 'source' as const, source: s, nested: false }))
    const out: Item[] = []
    for (const g of groups) {
      out.push({ type: 'group', group: g })
      // While filtering, every match shows even in a folded group.
      if (q || !isCollapsed(g.key)) for (const s of g.rows) out.push({ type: 'source', source: s, nested: true })
    }
    return out
  }, [groups, shown, q, isCollapsed])
  const group = source ? groupOf(source) : null

  const choose = (s: SourceInfo) => {
    setOpen(false)
    setText('')
    navigate({ to: '/', search: (p: Record<string, unknown>) => ({ ...p, source: s.name }) })
  }
  const onKey = (e: KeyboardEvent) => {
    const it = items[active]
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(items.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const key =
        it?.type === 'group'
          ? it.group.key
          : it?.type === 'source' && it.nested
            ? groups.find((g) => g.rows.includes(it.source))?.key
            : undefined
      if (!key) return
      e.preventDefault()
      set(key, e.key === 'ArrowLeft')
      if (e.key === 'ArrowLeft')
        setActive(
          Math.max(
            0,
            items.findIndex((x) => x.type === 'group' && x.group.key === key),
          ),
        )
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (it?.type === 'source') choose(it.source)
      else if (it?.type === 'group') set(it.group.key, !isCollapsed(it.group.key))
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o)
          setActive(
            Math.max(
              0,
              items.findIndex((x) => x.type === 'source' && x.source.name === name),
            ),
          )
      }}
    >
      <PopoverTrigger
        aria-label="Pick a source"
        className={cn(
          'flex h-8 min-w-0 items-center gap-2 border border-transparent px-2 outline-none hover:border-border focus-visible:border-ring',
          open && 'border-brand/60',
        )}
      >
        {group && (
          <>
            <span className="truncate font-mono text-[13px] text-muted-foreground">{group.name}</span>
            <span className="text-muted-foreground">/</span>
          </>
        )}
        <h1 className="truncate font-medium text-base">{source?.display_name ?? name ?? 'No source'}</h1>
        <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-110 gap-0 p-0">
        <div className="flex items-center gap-2 border-b px-3">
          <SearchIcon className="size-3.5 text-muted-foreground" />
          <input
            // biome-ignore lint/a11y/noAutofocus: the picker opens to type into
            autoFocus
            aria-label="Filter sources"
            placeholder="Filter sources"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKey}
            className="h-10 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
          <span className="font-mono text-[11px] text-muted-foreground">
            {listed.length} sources{groups.length ? ` · ${groups.length} groups` : ''}
          </span>
        </div>
        <div role="listbox" aria-label="Sources" className="max-h-[60vh] overflow-y-auto py-1">
          {items.map((it, i) =>
            it.type === 'group' ? (
              <div key={it.group.key} className={cn('px-2', i === active && 'bg-muted')}>
                <SourceGroupHeader
                  group={it.group}
                  compact
                  collapsed={!q && isCollapsed(it.group.key)}
                  onToggle={() => set(it.group.key, !isCollapsed(it.group.key))}
                />
              </div>
            ) : (
              <div
                key={it.source.name}
                role="option"
                tabIndex={-1}
                aria-selected={it.source.name === name}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(it.source)}
                onKeyDown={() => {}}
                className={cn(
                  'relative flex h-7 cursor-default items-center gap-2.5 pr-3 text-[13px]',
                  it.nested ? 'pl-9' : 'pl-3',
                  i === active &&
                    'bg-muted before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-brand',
                  !rates[it.source.name] && 'text-muted-foreground',
                )}
              >
                <StatusDot status={sourceStatus(it.source)} />
                <span className="flex-1 truncate">{it.source.display_name ?? it.source.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {fmtRate(rates[it.source.name])}
                </span>
                <span className="flex w-4 justify-end">
                  {it.source.name === name ? (
                    <CheckIcon className="size-3.5" />
                  ) : i === active ? (
                    <CornerDownLeftIcon className="size-3 text-muted-foreground" />
                  ) : null}
                </span>
              </div>
            ),
          )}
          {items.length === 0 && <p className="px-3 py-3 text-muted-foreground">No source matches.</p>}
        </div>
        <div className="flex items-center gap-2 border-t px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
          {groups.length > 0 && (
            <>
              <Kbd>←</Kbd>
              <Kbd>→</Kbd> fold
            </>
          )}
          <Kbd>↵</Kbd> stream
          <span className="flex-1" />
          one source at a time
        </div>
      </PopoverContent>
    </Popover>
  )
}
