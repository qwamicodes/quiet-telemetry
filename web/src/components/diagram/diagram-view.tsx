import { useNavigate } from '@tanstack/react-router'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsUpDownIcon,
  CopyIcon,
  FilterIcon,
  ImageDownIcon,
  InfoIcon,
  LockIcon,
  MaximizeIcon,
  MinimizeIcon,
  MinusIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ScanIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  XIcon,
} from 'lucide-react'
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { renderPng } from '@/components/diagram/export-png'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { LogLine } from '@/gen'
import { copy, copyText } from '@/lib/copy'
import {
  buildGraph,
  clampZoom,
  countLabel,
  type DiagramSettings,
  type DNode,
  type DRow,
  displayPath,
  dottedPath,
  filterQuery,
  fitView,
  forgetFolds,
  type Graph,
  LAYOUT,
  type Layout,
  layoutGraph,
  loadFolds,
  loadSettings,
  type Match,
  matchesUnder,
  openFor,
  pathId,
  saveFolds,
  saveSettings,
  searchLine,
  stepZoom,
  valueText,
} from '@/lib/diagram'
import { fmtSize, type LineStats, lineStats } from '@/lib/diagram-stats'
import { insideParsed, textQuery } from '@/lib/json-string'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

type View = { zoom: number; x: number; y: number }
type Menu = { row: DRow; x: number; y: number }

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

const LEVEL_KEYS = new Set(['level', 'severity', 'lvl'])
const MINI_W = 148
const MINI_H = 92

function valueClass(r: DRow): string {
  if (r.kind === 'num') return 'text-syntax-number'
  if (r.kind === 'bool' || r.kind === 'null') return 'text-syntax-literal'
  if (r.kind === 'str') return r.value === '' ? 'text-muted-foreground' : 'text-syntax-string'
  return 'text-muted-foreground'
}

/** `text` with search hits (warn tint, like the stream) and the highlighted value (brand tint) marked. */
function Marked({
  text,
  query,
  caseSensitive,
  highlight,
}: {
  text: string
  query: string
  caseSensitive: boolean
  highlight: string | null
}) {
  const needles: [string, string][] = []
  if (query) needles.push([query, 'bg-status-warn/30 text-inherit'])
  if (highlight && highlight.length >= 2) needles.push([highlight, 'bg-brand/20 text-inherit'])
  if (needles.length === 0) return <>{text}</>
  const hay = caseSensitive ? text : text.toLowerCase()
  const marks: { at: number; end: number; cls: string }[] = []
  for (const [n, cls] of needles) {
    const needle = caseSensitive || cls.includes('brand') ? n : n.toLowerCase()
    const src = cls.includes('brand') ? text : hay
    for (let i = src.indexOf(needle); i >= 0 && needle; i = src.indexOf(needle, i + needle.length)) {
      if (!marks.some((m) => i < m.end && i + needle.length > m.at)) marks.push({ at: i, end: i + needle.length, cls })
    }
  }
  if (marks.length === 0) return <>{text}</>
  marks.sort((a, b) => a.at - b.at)
  const out: ReactNode[] = []
  let last = 0
  for (const m of marks) {
    if (m.at > last) out.push(text.slice(last, m.at))
    out.push(
      <mark key={m.at} className={m.cls}>
        {text.slice(m.at, m.end)}
      </mark>,
    )
    last = m.end
  }
  out.push(text.slice(last))
  return <>{out}</>
}

function ToolButton({
  label,
  keys,
  onClick,
  active,
  children,
}: {
  label: string
  keys?: string
  onClick: () => void
  active?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-pressed={active}
            onClick={onClick}
            className={cn(active && 'bg-muted text-foreground')}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {keys && <Kbd>{keys}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

/** Rows that carry one of the line's correlation ids (Settings → Flow id order). */
function flowIdRows(g: Graph, line: LogLine): Set<string> {
  const out = new Set<string>()
  if (line.ids.length === 0) return out
  for (const n of g.nodes)
    for (const r of n.rows) {
      if (r.more || r.kind === 'obj' || r.kind === 'arr') continue
      const dotted = dottedPath(r.segs)
      const v = copyText(r.value)
      if (line.ids.some((i) => (i.key === dotted || i.key === r.key) && i.value === v)) out.add(r.id)
    }
  return out
}

export type DiagramViewProps = {
  line: LogLine & { fields: Record<string, unknown> }
  full: boolean
  onFullChange: (full: boolean) => void
  /** Esc (outside search and full screen): back to the 400px card. */
  onExit: () => void
  /** Values that were JSON strings (ids as `.payload`), drawn as cards and marked. */
  parsed?: ReadonlyMap<string, string>
}

/**
 * The Diagram tab (boards v0.1-04.8 … 04.13): the line's objects as cards on a
 * dotted canvas with pan and zoom, row actions, search, folding, a minimap for
 * large lines, PNG export and per-browser settings.
 */
export default function DiagramView({ line, full, onFullChange, onExit, parsed }: DiagramViewProps) {
  const navigate = useNavigate()
  const fields = line.fields
  const stats: LineStats = useMemo(() => lineStats(fields, line.raw), [fields, line.raw])
  const [settings, setSettingsState] = useState<DiagramSettings>(loadSettings)
  const setSettings = (patch: Partial<DiagramSettings>) => {
    const next = { ...settings, ...patch }
    setSettingsState(next)
    saveSettings(next)
    if (patch.remember === false) forgetFolds(line.source)
  }
  const [folds, setFolds] = useState(() =>
    settings.remember ? loadFolds(line.source) : { collapsed: new Set<string>(), expanded: new Set<string>() },
  )
  const [showAll, setShowAll] = useState<Set<string>>(() => new Set())
  const [expandAll, setExpandAll] = useState(false)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [current, setCurrent] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [view, setView] = useState<View>({ zoom: 1, x: 24, y: 24 })
  const [size, setSize] = useState({ w: 0, h: 0 })
  const viewportRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const matches: Match[] = useMemo(
    () => (searching && query ? searchLine(fields, query, caseSensitive) : []),
    [fields, searching, query, caseSensitive],
  )
  const forced = useMemo(() => openFor(matches, settings.arrayCap), [matches, settings.arrayCap])
  const graph = useMemo(
    () =>
      buildGraph(
        fields,
        {
          collapsed: folds.collapsed,
          expanded: folds.expanded,
          forced: forced.open,
          showAll: new Set([...showAll, ...forced.showAll]),
          expandAll,
        },
        { collapseDepth: settings.collapseDepth, arrayCap: settings.arrayCap },
      ),
    [fields, folds, forced, showAll, expandAll, settings.collapseDepth, settings.arrayCap],
  )
  const flowIds = useMemo(() => flowIdRows(graph, line), [graph, line])
  const searchOn = matches.length > 0
  const matchedRows = useMemo(() => new Set(matches.map((m) => m.row)), [matches])
  const matchedNodes = useMemo(() => {
    const s = new Set<string>()
    for (const m of matches) {
      // A card "has" a match when the match is in it or below it.
      for (let i = 0; i < m.segs.length; i++) s.add(pathId(m.segs.slice(0, i)))
    }
    return s
  }, [matches])
  const layout: Layout = useMemo(
    () =>
      layoutGraph(graph, {
        direction: settings.direction,
        wrap: settings.wrap,
        flowIds,
        extra: (r) =>
          (r.segs.length === 1 && LEVEL_KEYS.has(r.key) && typeof r.value === 'number' && line.level ? 7 : 0) +
          (searchOn && r.count ? 4 : 0),
      }),
    [graph, settings.direction, settings.wrap, flowIds, line.level, searchOn],
  )
  const cur = matches.length ? Math.min(current, matches.length - 1) : -1
  const currentMatch = cur >= 0 ? matches[cur] : null

  // Viewport size (ResizeObserver; jsdom has none and reports 0).
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // First paint: top-left at 100%, or smaller (not under 60%) when the line is big.
  const placed = useRef(false)
  useEffect(() => {
    if (placed.current || size.w === 0) return
    placed.current = true
    const f = fitView(layout.width, layout.height, size.w, size.h)
    setView({ zoom: clampZoom(Math.max(0.6, f.zoom)), x: 24, y: stats.large ? 56 : 24 })
  }, [size, layout.width, layout.height, stats.large])

  const fitAll = useCallback(() => setView(fitView(layout.width, layout.height, size.w, size.h)), [layout, size])
  const zoomTo = useCallback(
    (z: number, at?: { x: number; y: number }) =>
      setView((v) => {
        const zoom = clampZoom(z)
        const px = at?.x ?? size.w / 2
        const py = at?.y ?? size.h / 2
        return { zoom, x: px - ((px - v.x) * zoom) / v.zoom, y: py - ((py - v.y) * zoom) / v.zoom }
      }),
    [size],
  )

  // Keep the current match on screen.
  useEffect(() => {
    if (!currentMatch) return
    const b = layout.boxes.get(currentMatch.node)
    const n = graph.byId.get(currentMatch.node)
    if (!b || !n) return
    const i = n.rows.findIndex((r) => r.id === currentMatch.row)
    if (i < 0) return
    setView((v) => {
      const rx = b.x * v.zoom + v.x
      const ry = (b.y + b.rowY[i]) * v.zoom + v.y
      const inside = rx >= 0 && ry >= 0 && rx + b.w * v.zoom <= size.w && ry + 24 <= size.h
      if (inside || size.w === 0) return v
      return { ...v, x: size.w / 2 - (b.x + b.w / 2) * v.zoom, y: size.h / 2 - (b.y + b.rowY[i]) * v.zoom }
    })
  }, [currentMatch, layout, graph, size])

  // Wheel: pan, or zoom with ⌘/Ctrl (and pinch). Non-passive so the page does not scroll.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect()
        setView((v) => {
          const zoom = clampZoom(v.zoom * Math.exp(-e.deltaY * 0.0025))
          const px = e.clientX - r.left
          const py = e.clientY - r.top
          return { zoom, x: px - ((px - v.x) * zoom) / v.zoom, y: py - ((py - v.y) * zoom) / v.zoom }
        })
      } else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Drag the background to pan.
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-card],[data-ui]')) return
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    setMenu(null)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }))
  }
  const onPointerUp = () => {
    drag.current = null
  }

  const rememberFolds = (next: { collapsed: Set<string>; expanded: Set<string> }) => {
    setFolds(next)
    if (settings.remember) saveFolds(line.source, next)
  }
  const toggle = (r: DRow) => {
    const collapsed = new Set(folds.collapsed)
    const expanded = new Set(folds.expanded)
    if (r.open) {
      collapsed.add(r.id)
      expanded.delete(r.id)
    } else {
      collapsed.delete(r.id)
      expanded.add(r.id)
    }
    rememberFolds({ collapsed, expanded })
  }
  const toggleExpandAll = () => {
    if (expandAll) {
      setExpandAll(false)
      rememberFolds({ collapsed: new Set(folds.collapsed), expanded: new Set() })
    } else {
      setExpandAll(true)
      rememberFolds({ collapsed: new Set(), expanded: new Set(folds.expanded) })
    }
  }

  const rowById = useCallback(
    (id: string | null): DRow | undefined => {
      if (id == null) return undefined
      for (const n of graph.nodes) for (const r of n.rows) if (r.id === id) return r
      return undefined
    },
    [graph],
  )
  const leaf = (r: DRow) => r.kind !== 'obj' && r.kind !== 'arr' && !r.more
  const copyValue = (r: DRow) => copy(copyText(r.value ?? null), r.key || 'value')
  const copyPath = (r: DRow) => copy(displayPath(r.segs), 'path')
  // Search can't look inside a JSON string field: values parsed out of one search the text.
  const filterBy = (r: DRow, exclude = false) =>
    navigate({
      to: '/search',
      search: {
        q: insideParsed(r.segs, parsed) ? textQuery(r.value, exclude) : filterQuery(r.segs, r.value, exclude),
      },
    })
  const highlightOf = (r: DRow) => copyText(r.value)
  const toggleHighlight = (r: DRow) => setHighlight((h) => (h === highlightOf(r) ? null : highlightOf(r)))
  const stageFlowId = (r: DRow) => navigate({ to: '/settings/flow-id-order', search: { add: dottedPath(r.segs) } })
  const copyJson = () => copy(JSON.stringify(fields, null, 2), 'line as JSON')
  const exportPng = async () => {
    const blob = await renderPng(graph, layout, flowIds)
    if (!blob) {
      toast.error('Could not draw the image in this browser')
      return
    }
    const file = `quiet-line-${line.id}.png`
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = file
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    toast.success('Exported image', { description: `${file} · ${fmtSize(blob.size)}` })
  }
  const highlightCount = (r: DRow) => searchLine(fields, highlightOf(r), true).filter((m) => m.on !== 'key').length

  const openSearch = () => {
    setSearching(true)
    setMenu(null)
    requestAnimationFrame(() => searchRef.current?.focus())
  }
  const closeSearch = () => {
    setSearching(false)
    setQuery('')
    setCurrent(0)
  }
  const step = (by: 1 | -1) => {
    if (!matches.length) return
    setCurrent((c) => (Math.min(c, matches.length - 1) + by + matches.length) % matches.length)
  }

  // Diagram keys, in the capture phase so Esc here never reaches the flow's
  // "back to stream" (or the stream's own keys) underneath.
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keysRef.current = (e: KeyboardEvent) => {
    const key = e.key === 'Escape' ? 'escape' : e.key.toLowerCase()
    const mod = e.metaKey || e.ctrlKey
    const handled = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (key === 'escape') {
      // A popup (settings, tooltip) closes itself first.
      if (settingsOpen) return
      handled()
      if (menu) setMenu(null)
      else if (searching) closeSearch()
      else if (full) onFullChange(false)
      else onExit()
      return
    }
    if (mod && key === 'f') {
      handled()
      openSearch()
      return
    }
    if (mod || e.altKey || isTyping(e.target) || settingsOpen) return
    const sel = rowById(selected)
    if (key === '/') {
      handled()
      openSearch()
    } else if (key === '0') {
      handled()
      fitAll()
    } else if (key === '=' || key === '+') {
      handled()
      zoomTo(stepZoom(view.zoom, 1))
    } else if (key === '-') {
      handled()
      zoomTo(stepZoom(view.zoom, -1))
    } else if (key === 'c') {
      handled()
      if (sel && !sel.more) copyValue(sel)
      else copyJson()
    } else if (key === 'f' && sel && leaf(sel)) {
      handled()
      filterBy(sel, e.shiftKey)
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keysRef.current(e)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // The menu closes on any click outside it.
  useEffect(() => {
    if (!menu) return
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('[data-row-menu]')) setMenu(null)
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [menu])

  const openMenu = (r: DRow, clientX: number, clientY: number) => {
    const el = viewportRef.current
    const rect = el?.getBoundingClientRect()
    const x = rect ? clientX - rect.left : clientX
    const y = rect ? clientY - rect.top : clientY
    setSelected(r.id)
    setMenu({
      row: r,
      x: Math.max(4, Math.min(x, (size.w || 1e6) - 236)),
      y: Math.max(4, Math.min(y, (size.h || 1e6) - 220)),
    })
  }

  const selectedRow = rowById(selected)
  const overflow = layout.width * view.zoom > size.w + 1 || layout.height * view.zoom > size.h + 1
  const showMinimap = size.w > 0 && (stats.large || overflow)
  const status = (() => {
    if (searching && query) {
      if (!matches.length) return `no matches for “${query}”`
      const objects = new Set(matches.map((m) => m.node)).size
      return `${matches.length} ${matches.length === 1 ? 'match' : 'matches'} in ${objects} ${objects === 1 ? 'object' : 'objects'} · ${cur + 1} / ${matches.length}${currentMatch ? ` · ${displayPath(currentMatch.segs)}` : ''}`
    }
    if (selectedRow && !selectedRow.more) {
      const where =
        highlight != null
          ? searchLine(fields, highlight, true)
              .filter((m) => m.on !== 'key' && m.row !== selectedRow.id)
              .map((m) => displayPath(m.segs))
          : []
      return `selected ${displayPath(selectedRow.segs)}${where.length ? ` · same value highlighted in ${where.slice(0, 3).join(', ')}` : ''}${graph.collapsed ? ` · ${graph.collapsed} collapsed` : ''}`
    }
    if (graph.hidden.length || graph.collapsed) {
      return [
        graph.hidden.length > 0 && `${graph.hidden.join(', ')} hidden`,
        graph.collapsed > 0 && `${graph.collapsed} ${graph.collapsed === 1 ? 'branch' : 'branches'} collapsed`,
        'nothing is dropped: Raw and JSON hold the whole line',
      ]
        .filter(Boolean)
        .join(' · ')
    }
    return 'click a value to copy · right-click for actions'
  })()

  const dots: CSSProperties = {
    backgroundImage:
      'radial-gradient(circle, color-mix(in oklab, var(--muted-foreground) 32%, transparent) 1px, transparent 1.3px)',
    backgroundSize: `${20 * view.zoom}px ${20 * view.zoom}px`,
    backgroundPosition: `${view.x}px ${view.y}px`,
  }

  return (
    <div data-testid="diagram" className="flex min-h-0 flex-1 flex-col">
      <div
        ref={viewportRef}
        data-testid="diagram-canvas"
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-background select-none active:cursor-grabbing"
        style={dots}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          }}
        >
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-visible"
            width={layout.width}
            height={layout.height}
          >
            {layout.edges.map((e) => {
              const p = graph.byId.get(e.from)
              const active = selected != null && p?.rows[e.row]?.id === selected
              return (
                <path
                  key={e.key}
                  d={e.d}
                  fill="none"
                  strokeWidth={active ? 1.5 : 1}
                  className={cn(
                    active ? 'stroke-brand' : 'stroke-muted-foreground/50',
                    searchOn && !matchedNodes.has(e.to) && 'opacity-30',
                  )}
                />
              )
            })}
          </svg>
          {graph.nodes.map((n) => (
            <Card
              key={n.id}
              node={n}
              layout={layout}
              line={line}
              flowIds={flowIds}
              parsed={parsed}
              dim={searchOn && !matchedNodes.has(n.id)}
              matches={matches}
              matchedRows={matchedRows}
              currentRow={currentMatch?.row ?? null}
              query={searching ? query : ''}
              caseSensitive={caseSensitive}
              highlight={highlight}
              selected={selected}
              wrap={settings.wrap}
              onSelect={(r) => {
                setSelected((s) => (s === r.id ? null : r.id))
                setMenu(null)
              }}
              onCopy={(r) => {
                setSelected(r.id)
                copyValue(r)
              }}
              onFilter={(r) => filterBy(r)}
              onMenu={openMenu}
              onToggle={toggle}
              onShowAll={(array) => setShowAll((s) => new Set([...s, array]))}
            />
          ))}
        </div>

        {stats.large && (
          <div
            data-ui
            className="absolute top-3 left-3 flex h-8 items-center gap-2 border bg-card px-3 font-mono text-[11px] shadow-sm"
          >
            <InfoIcon className="size-3.5 text-muted-foreground" />
            <span>
              Large line · {stats.keys} keys · {fmtSize(stats.bytes)}
            </span>
            <span className="text-muted-foreground">
              · past depth {settings.collapseDepth} starts collapsed · arrays show {settings.arrayCap} items
            </span>
            <Button variant="ghost" size="xs" onClick={toggleExpandAll}>
              <ChevronsUpDownIcon />
              {expandAll ? `Collapse past depth ${settings.collapseDepth}` : 'Expand all'}
            </Button>
          </div>
        )}

        {searching && (
          <div data-ui className="absolute top-3 right-3 flex flex-col items-end gap-1">
            <div className="flex items-center gap-1 border bg-card p-1 shadow-sm">
              <div className="flex h-7 w-60 items-center gap-2 border border-ring px-2 font-mono text-xs">
                <input
                  ref={searchRef}
                  aria-label="Search keys and values"
                  placeholder="keys and values"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setCurrent(0)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      step(e.shiftKey ? -1 : 1)
                    }
                  }}
                  className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
                />
                <span data-testid="diagram-match-count" className="shrink-0 text-muted-foreground tabular-nums">
                  {query ? `${matches.length ? cur + 1 : 0} / ${matches.length}` : ''}
                </span>
              </div>
              <Button variant="ghost" size="icon-sm" aria-label="Previous match" onClick={() => step(-1)}>
                <ArrowUpIcon />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Next match" onClick={() => step(1)}>
                <ArrowDownIcon />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Match case"
                aria-pressed={caseSensitive}
                onClick={() => setCaseSensitive((c) => !c)}
                className={cn('h-7 px-1.5 font-mono text-[11px]', caseSensitive && 'bg-muted text-foreground')}
              >
                Aa
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Close search" onClick={closeSearch}>
                <XIcon />
              </Button>
            </div>
            <p className="text-right font-mono text-[11px] text-muted-foreground leading-relaxed">
              keys and values · ↵ next · ⇧↵ previous · Esc close
              <br />
              collapsed branches with a match open; others dim
            </p>
          </div>
        )}

        {showMinimap && (
          <Minimap
            layout={layout}
            graph={graph}
            view={view}
            size={size}
            onMove={(x, y) => setView((v) => ({ ...v, x, y }))}
          />
        )}

        <div
          data-ui
          role="toolbar"
          aria-label="Diagram"
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-0.5 border bg-card p-1 shadow-md"
        >
          <ToolButton label="Fit" keys="0" onClick={fitAll}>
            <ScanIcon />
          </ToolButton>
          <ToolButton label={full ? 'Exit full screen' : 'Full screen'} onClick={() => onFullChange(!full)}>
            {full ? <MinimizeIcon /> : <MaximizeIcon />}
          </ToolButton>
          <span className="mx-1 h-5 w-px bg-border" />
          <ToolButton label="Zoom out" keys="-" onClick={() => zoomTo(stepZoom(view.zoom, -1))}>
            <MinusIcon />
          </ToolButton>
          <button
            type="button"
            aria-label="Zoom to 100%"
            title="Zoom to 100%"
            onClick={() => zoomTo(1)}
            className="h-7 w-12 font-mono text-[11px] text-muted-foreground tabular-nums hover:text-foreground"
          >
            {Math.round(view.zoom * 100)}%
          </button>
          <ToolButton label="Zoom in" keys="+" onClick={() => zoomTo(stepZoom(view.zoom, 1))}>
            <PlusIcon />
          </ToolButton>
          <span className="mx-1 h-5 w-px bg-border" />
          <ToolButton label="Export image (PNG)" onClick={() => void exportPng()}>
            <ImageDownIcon />
          </ToolButton>
          <ToolButton
            label="Search"
            keys="/"
            active={searching}
            onClick={() => (searching ? closeSearch() : openSearch())}
          >
            <SearchIcon />
          </ToolButton>
          <ToolButton label="Copy JSON" onClick={copyJson}>
            <CopyIcon />
          </ToolButton>
          <span className="mx-1 h-5 w-px bg-border" />
          <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <PopoverTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Diagram settings"
                        className={cn(settingsOpen && 'bg-muted text-foreground')}
                      />
                    }
                  />
                }
              >
                <SlidersHorizontalIcon />
              </TooltipTrigger>
              <TooltipContent>Diagram settings</TooltipContent>
            </Tooltip>
            <PopoverContent side="top" align="end" sideOffset={8} className="w-[340px] gap-0 p-0">
              <SettingsPanel settings={settings} onChange={setSettings} />
            </PopoverContent>
          </Popover>
        </div>

        {menu && (
          <RowMenu
            menu={menu}
            highlighted={highlight != null && highlight === highlightOf(menu.row)}
            highlightCount={leaf(menu.row) ? highlightCount(menu.row) : 0}
            onClose={() => setMenu(null)}
            leaf={leaf(menu.row)}
            onCopyValue={() => copyValue(menu.row)}
            onCopyPath={() => copyPath(menu.row)}
            onFilter={() => filterBy(menu.row)}
            onExclude={() => filterBy(menu.row, true)}
            onHighlight={() => toggleHighlight(menu.row)}
            onFlowId={() => stageFlowId(menu.row)}
          />
        )}
      </div>
      {!full && (
        <footer className="flex h-9 shrink-0 items-center gap-4 border-t px-4 font-mono text-[11px] text-muted-foreground">
          <span data-testid="diagram-status" className="min-w-0 flex-1 truncate">
            {status}
          </span>
          {searching ? (
            <span className="flex shrink-0 items-center gap-1.5">
              <Kbd>↵</Kbd> next <Kbd className="ml-2">⇧↵</Kbd> previous <Kbd className="ml-2">Esc</Kbd> close search
            </span>
          ) : (
            <span className="flex shrink-0 items-center gap-1.5">
              <Kbd>C</Kbd> copy value <Kbd className="ml-2">F</Kbd> filter <Kbd className="ml-2">/</Kbd> search{' '}
              <Kbd className="ml-2">0</Kbd> fit <Kbd className="ml-2">Esc</Kbd> back to card
            </span>
          )}
        </footer>
      )}
    </div>
  )
}

function Card({
  node: n,
  layout,
  line,
  flowIds,
  parsed,
  dim,
  matches,
  matchedRows,
  currentRow,
  query,
  caseSensitive,
  highlight,
  selected,
  wrap,
  onSelect,
  onCopy,
  onFilter,
  onMenu,
  onToggle,
  onShowAll,
}: {
  node: DNode
  layout: Layout
  line: LogLine
  flowIds: ReadonlySet<string>
  parsed?: ReadonlyMap<string, string>
  dim: boolean
  matches: Match[]
  matchedRows: ReadonlySet<string>
  currentRow: string | null
  query: string
  caseSensitive: boolean
  highlight: string | null
  selected: string | null
  wrap: boolean
  onSelect: (r: DRow) => void
  onCopy: (r: DRow) => void
  onFilter: (r: DRow) => void
  onMenu: (r: DRow, x: number, y: number) => void
  onToggle: (r: DRow) => void
  onShowAll: (array: string) => void
}) {
  const b = layout.boxes.get(n.id)
  if (!b) return null
  const searchOn = matches.length > 0
  return (
    <section
      data-card
      data-node={n.id}
      aria-label={n.title}
      className={cn(
        'absolute border bg-card font-mono text-xs shadow-sm transition-opacity',
        n.error && 'border-level-error/40',
        dim && 'opacity-40',
      )}
      style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
    >
      <header
        className={cn(
          'flex items-center justify-between gap-2 border-b px-2.5',
          n.error ? 'border-level-error/30 bg-level-error-muted text-level-error' : 'bg-muted/60',
        )}
        style={{ height: LAYOUT.header }}
      >
        <span className="truncate">{n.title}</span>
        {parsed?.has(n.id) && (
          <span
            data-testid="parsed-card"
            title="Parsed from a JSON string"
            className="shrink-0 border px-1 text-[10px] text-muted-foreground leading-4"
          >
            from string
          </span>
        )}
        <span className="flex-1" />
        <span className="shrink-0 text-muted-foreground">{countLabel(n.kind, n.count)}</span>
      </header>
      {n.rows.map((r, i) => {
        const h = b.rowH[i]
        if (r.more) {
          const more = r.more
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => onShowAll(more.array)}
              className="flex w-full items-center gap-1.5 px-2.5 text-left hover:bg-row-hover"
              style={{ height: h }}
            >
              <span className="text-brand">+ {more.hidden} more</span>
              <span className="text-muted-foreground">
                · showing {more.shown} of {more.total}
              </span>
            </button>
          )
        }
        const isMatch = matchedRows.has(r.id)
        const under = searchOn && r.count ? matchesUnder(matches, r.id) : 0
        const branch = r.kind === 'obj' || r.kind === 'arr'
        const text = valueText(r.value)
        const levelHint =
          r.segs.length === 1 && LEVEL_KEYS.has(r.key) && typeof r.value === 'number' && line.level ? line.level : null
        return (
          // biome-ignore lint/a11y/useSemanticElements: a row holds buttons, so it cannot be one
          <div
            key={r.id}
            data-row={r.id}
            role="button"
            tabIndex={-1}
            aria-label={r.key}
            aria-pressed={selected === r.id}
            onClick={() => onSelect(r)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSelect(r)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              onMenu(r, e.clientX, e.clientY)
            }}
            className={cn(
              'group/row relative flex cursor-default gap-0 border-border/60 border-t px-2.5 outline-none hover:bg-row-hover',
              wrap ? 'items-start py-[3px] leading-[18px]' : 'items-center',
              selected === r.id && 'bg-row-selected shadow-[inset_2px_0_0_var(--brand)]',
              currentRow === r.id && 'ring-1 ring-brand ring-inset',
              searchOn && !isMatch && !under && 'opacity-45',
            )}
            style={{ height: h }}
          >
            <span className="shrink-0 text-syntax-key">
              <Marked text={r.key} query={query} caseSensitive={caseSensitive} highlight={null} />:
            </span>
            <span className="w-1.5 shrink-0" />
            <button
              type="button"
              title="Click to copy"
              aria-label={`Copy ${r.key}`}
              onClick={(e) => {
                e.stopPropagation()
                onCopy(r)
              }}
              className={cn(
                'min-w-0 cursor-pointer text-left decoration-dotted underline-offset-2 hover:underline',
                wrap ? 'break-all whitespace-pre-wrap' : 'truncate whitespace-pre',
                valueClass(r),
              )}
            >
              <Marked
                text={text}
                query={branch ? '' : query}
                caseSensitive={caseSensitive}
                highlight={branch ? null : highlight}
              />
            </button>
            {levelHint && <span className="ml-1.5 shrink-0 text-[11px] text-muted-foreground">{levelHint}</span>}
            {r.preview && <span className="ml-1.5 truncate text-[11px] text-muted-foreground">{r.preview}</span>}
            {parsed?.has(r.id) && (
              <span
                title="Sent as a string holding JSON"
                className="ml-2 shrink-0 border px-1 text-[10px] text-muted-foreground leading-4"
              >
                json str
              </span>
            )}
            {flowIds.has(r.id) && (
              <span className="ml-2 shrink-0 border border-brand/40 px-1 text-[10px] text-brand leading-4">
                flow id
              </span>
            )}
            {under > 0 && (
              <span className="ml-2 shrink-0 bg-status-warn/25 px-1 text-[10px] text-status-warn leading-4">
                {under}
              </span>
            )}
            <span className="flex-1" />
            <span
              data-ui
              className="absolute top-1/2 right-4 hidden -translate-y-1/2 items-center gap-0.5 bg-card/95 pl-1 group-hover/row:flex"
            >
              <RowIcon label="Copy value" onClick={() => onCopy(r)}>
                <CopyIcon />
              </RowIcon>
              {!branch && (
                <RowIcon label="Filter by value" onClick={() => onFilter(r)}>
                  <FilterIcon />
                </RowIcon>
              )}
              <RowIcon
                label="More actions"
                onClick={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  onMenu(r, rect.right - 220, rect.bottom + 4)
                }}
              >
                <MoreHorizontalIcon />
              </RowIcon>
            </span>
            {branch && r.count ? (
              <button
                type="button"
                data-ui
                aria-label={r.open ? `Collapse ${r.key}` : `Expand ${r.key}`}
                aria-expanded={Boolean(r.open)}
                onClick={(e) => {
                  e.stopPropagation()
                  onToggle(r)
                }}
                className={cn(
                  'absolute top-1/2 -right-[7px] z-10 flex size-3.5 -translate-y-1/2 items-center justify-center border bg-card text-muted-foreground hover:border-brand hover:text-foreground',
                  r.open && selected === r.id && 'border-brand text-brand',
                )}
              >
                {r.open ? <MinusIcon className="size-2.5" /> : <PlusIcon className="size-2.5" />}
              </button>
            ) : null}
          </div>
        )
      })}
    </section>
  )
}

function RowIcon({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: (e: React.MouseEvent) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick(e)
      }}
      className="flex size-5 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-3"
    >
      {children}
    </button>
  )
}

function RowMenu({
  menu,
  leaf,
  highlighted,
  highlightCount,
  onClose,
  onCopyValue,
  onCopyPath,
  onFilter,
  onExclude,
  onHighlight,
  onFlowId,
}: {
  menu: Menu
  leaf: boolean
  highlighted: boolean
  highlightCount: number
  onClose: () => void
  onCopyValue: () => void
  onCopyPath: () => void
  onFilter: () => void
  onExclude: () => void
  onHighlight: () => void
  onFlowId: () => void
}) {
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => first.current?.focus(), [])
  const path = displayPath(menu.row.segs)
  const item = (
    label: ReactNode,
    run: () => void,
    hint?: ReactNode,
    opts: { disabled?: boolean; checked?: boolean; ref?: React.Ref<HTMLButtonElement> } = {},
  ) => (
    <button
      ref={opts.ref}
      type="button"
      role="menuitem"
      disabled={opts.disabled}
      onClick={() => {
        run()
        onClose()
      }}
      className="flex h-7 w-full items-center gap-2 px-2 text-left outline-none hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-50"
    >
      <span className="w-3.5 shrink-0 text-brand">{opts.checked ? '✓' : ''}</span>
      <span className="flex-1 truncate">{label}</span>
      {hint}
    </button>
  )
  return (
    <div
      data-ui
      data-row-menu
      role="menu"
      aria-label={`Actions for ${path}`}
      className="absolute z-30 w-[228px] bg-popover p-1 text-popover-foreground text-xs shadow-md ring-1 ring-foreground/10"
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)')]
          const i = items.indexOf(document.activeElement as HTMLButtonElement)
          items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
        }
      }}
    >
      {item('Copy value', onCopyValue, <Kbd>C</Kbd>, { ref: first })}
      {item(
        'Copy path',
        onCopyPath,
        <span className="max-w-24 truncate font-mono text-[11px] text-muted-foreground">{path}</span>,
      )}
      {item('Filter by value', onFilter, <Kbd>F</Kbd>, { disabled: !leaf })}
      {item(
        'Exclude value',
        onExclude,
        <span className="flex gap-0.5">
          <Kbd>⇧</Kbd>
          <Kbd>F</Kbd>
        </span>,
        { disabled: !leaf },
      )}
      <div className="-mx-1 my-1 h-px bg-border" />
      {item(
        'Highlight this value',
        onHighlight,
        highlightCount > 1 ? <span className="text-[11px] text-muted-foreground">{highlightCount}</span> : undefined,
        { disabled: !leaf, checked: highlighted },
      )}
      {item('Use as a flow id…', onFlowId, undefined, { disabled: !leaf })}
    </div>
  )
}

function SettingsPanel({
  settings,
  onChange,
}: {
  settings: DiagramSettings
  onChange: (patch: Partial<DiagramSettings>) => void
}) {
  const row = 'flex min-h-10 items-center justify-between gap-3 border-b px-3.5 py-1.5'
  const num = (value: number, min: number, max: number, set: (n: number) => void, label: string) => (
    <input
      type="number"
      aria-label={label}
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value)
        if (Number.isInteger(n) && n >= min && n <= max) set(n)
      }}
      className="h-7 w-16 border bg-background px-2 font-mono text-xs outline-none focus-visible:border-ring"
    />
  )
  return (
    <div className="flex flex-col text-xs">
      <div className="px-3.5 pt-3 pb-1 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
        Diagram
      </div>
      <div className={row}>
        <span>Direction</span>
        <fieldset className="m-0 flex min-w-0 border p-0" aria-label="Direction">
          {(
            [
              ['lr', 'Left → right'],
              ['tb', 'Top → down'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={settings.direction === v}
              onClick={() => onChange({ direction: v })}
              className={cn(
                'h-7 px-2.5 text-xs',
                settings.direction === v ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </fieldset>
      </div>
      <div className={row}>
        <span>Value types</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          <span className="text-syntax-string">str</span> · <span className="text-syntax-number">num</span> ·{' '}
          <span className="text-syntax-literal">bool</span> shown by colour
        </span>
      </div>
      <div className={row}>
        <span>Start collapsed past depth</span>
        {num(settings.collapseDepth, 1, 12, (n) => onChange({ collapseDepth: n }), 'Start collapsed past depth')}
      </div>
      <div className={row}>
        <span>Array items before “more”</span>
        {num(settings.arrayCap, 1, 100, (n) => onChange({ arrayCap: n }), 'Array items before more')}
      </div>
      <div className={row}>
        <span>Wrap long values</span>
        <Switch aria-label="Wrap long values" checked={settings.wrap} onCheckedChange={(v) => onChange({ wrap: v })} />
      </div>
      <div className={row}>
        <span>Remember collapsed branches</span>
        <Switch
          aria-label="Remember collapsed branches"
          checked={settings.remember}
          onCheckedChange={(v) => onChange({ remember: v })}
        />
      </div>
      <p className="flex gap-2 px-3.5 py-3 text-[11px] text-muted-foreground leading-relaxed">
        <LockIcon className="mt-0.5 size-3 shrink-0" />
        Masked fields stay masked here and in Export image (source settings). Saved in this browser.
      </p>
    </div>
  )
}

/** Every card as a block, the part on screen as a box; click or drag to move there (04.11). */
function Minimap({
  layout,
  graph,
  view,
  size,
  onMove,
}: {
  layout: Layout
  graph: Graph
  view: View
  size: { w: number; h: number }
  onMove: (x: number, y: number) => void
}) {
  const scale = Math.min((MINI_W - 8) / Math.max(1, layout.width), (MINI_H - 8) / Math.max(1, layout.height))
  const ox = (MINI_W - layout.width * scale) / 2
  const oy = (MINI_H - layout.height * scale) / 2
  const vp = {
    x: (-view.x / view.zoom) * scale + ox,
    y: (-view.y / view.zoom) * scale + oy,
    w: (size.w / view.zoom) * scale,
    h: (size.h / view.zoom) * scale,
  }
  const dragging = useRef(false)
  const moveTo = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const cx = (e.clientX - r.left - ox) / scale
    const cy = (e.clientY - r.top - oy) / scale
    onMove(size.w / 2 - cx * view.zoom, size.h / 2 - cy * view.zoom)
  }
  return (
    <svg
      data-ui
      data-testid="diagram-minimap"
      role="img"
      aria-label="Minimap"
      width={MINI_W}
      height={MINI_H}
      className="absolute right-3 bottom-4 cursor-pointer border bg-card shadow-sm"
      onPointerDown={(e) => {
        dragging.current = true
        e.currentTarget.setPointerCapture?.(e.pointerId)
        moveTo(e)
      }}
      onPointerMove={(e) => dragging.current && moveTo(e)}
      onPointerUp={() => {
        dragging.current = false
      }}
    >
      {graph.nodes.map((n) => {
        const b = layout.boxes.get(n.id)
        if (!b) return null
        return (
          <rect
            key={n.id}
            x={b.x * scale + ox}
            y={b.y * scale + oy}
            width={Math.max(2, b.w * scale)}
            height={Math.max(2, b.h * scale)}
            className={n.error ? 'fill-level-error/50' : 'fill-muted-foreground/35'}
          />
        )
      })}
      <rect
        x={vp.x}
        y={vp.y}
        width={Math.max(4, vp.w)}
        height={Math.max(4, vp.h)}
        className="fill-brand/10 stroke-brand"
        strokeWidth={1}
      />
    </svg>
  )
}
