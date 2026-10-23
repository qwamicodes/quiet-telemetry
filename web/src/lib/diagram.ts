/**
 * The Diagram tab's model (boards v0.1-04.8 … 04.14): one log line turned into
 * cards (one per object or array), rows of `key: value`, and edges from a
 * parent row to its child card, laid out left → right (or top → down).
 *
 * Pure and framework-free so the transform, search and layout are unit-tested
 * without a DOM. Loaded only with the Diagram tab (lazy chunk).
 */
import { z } from 'zod'
import { copyText } from '@/lib/copy'
import { ARRAY_CAP, COLLAPSE_DEPTH } from '@/lib/diagram-stats'
import { chip } from '@/lib/row'

export type Seg = string | number
export type Kind = 'str' | 'num' | 'bool' | 'null' | 'obj' | 'arr'

export function kindOf(v: unknown): Kind {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return 'arr'
  if (typeof v === 'number') return 'num'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'object') return 'obj'
  return 'str'
}

/** A stable id for a place in the line: `.wideEvents.calls[3].name` (root is ``). */
export const pathId = (segs: readonly Seg[]) => segs.map((s) => (typeof s === 'number' ? `[${s}]` : `.${s}`)).join('')
/** What the user reads: `wideEvents.calls[3].name`. */
export const displayPath = (segs: readonly Seg[]) => pathId(segs).replace(/^\./, '')
/** The search language's dotted key (`err.code`); only meaningful without array indexes. */
export const dottedPath = (segs: readonly Seg[]) => segs.join('.')
const hasIndex = (segs: readonly Seg[]) => segs.some((s) => typeof s === 'number')

/** A value as a row shows it: strings bare (`""` when empty), the rest as JSON-ish text. */
export function valueText(v: unknown): string {
  const k = kindOf(v)
  if (k === 'str') return (v as string) === '' ? '""' : (v as string)
  if (k === 'null') return 'null'
  if (k === 'obj') return countLabel('obj', Object.keys(v as object).length)
  if (k === 'arr') return countLabel('arr', (v as unknown[]).length)
  return String(v)
}

/** `{17 keys}` / `[14 items]`, `{}` / `[]` when empty. */
export function countLabel(kind: 'obj' | 'arr', n: number): string {
  if (kind === 'arr') return n === 0 ? '[]' : `[${n} ${n === 1 ? 'item' : 'items'}]`
  return n === 0 ? '{}' : `{${n} ${n === 1 ? 'key' : 'keys'}}`
}

const PREVIEW_KEYS = ['name', 'type', 'op', 'operation', 'event', 'step', 'id', 'key']
/** `auth.verify` beside `0: {6 keys}`: a short label for an object inside an array. */
function previewOf(v: unknown): string | undefined {
  if (kindOf(v) !== 'obj') return undefined
  const o = v as Record<string, unknown>
  const key =
    PREVIEW_KEYS.find((k) => typeof o[k] === 'string' && o[k]) ??
    Object.keys(o).find((k) => typeof o[k] === 'string' && o[k])
  if (!key) return undefined
  const s = o[key] as string
  return s.length > 24 ? `${s.slice(0, 23)}…` : s
}

const isErrorKey = (k: Seg | undefined) => typeof k === 'string' && /^(err|error|exception)$/i.test(k)

export type DRow = {
  /** pathId of this row's value. */
  id: string
  key: string
  segs: Seg[]
  kind: Kind
  value: unknown
  /** Keys / items, for objects and arrays. */
  count?: number
  /** Whether a non-empty object/array row has its card open. */
  open?: boolean
  /** The child card's id when open. */
  child?: string
  preview?: string
  /** Set on the closing "+ N more · showing 5 of 14" row of a capped array. */
  more?: { array: string; hidden: number; shown: number; total: number }
}

export type DNode = {
  id: string
  segs: Seg[]
  title: string
  kind: 'obj' | 'arr'
  count: number
  depth: number
  rows: DRow[]
  /** `error` / `err` objects get the error tint. */
  error: boolean
  parent?: { node: string; row: number }
}

export type DEdge = { from: string; row: number; to: string }

export type Graph = {
  nodes: DNode[]
  edges: DEdge[]
  byId: Map<string, DNode>
  /** Branches drawn closed (they still hold data). */
  collapsed: number
  /** Array items not drawn because of the cap, as `calls[5…13]`. */
  hidden: string[]
}

export type Fold = {
  /** Branches the user closed. */
  collapsed: ReadonlySet<string>
  /** Branches past the collapse depth the user opened. */
  expanded: ReadonlySet<string>
  /** Branches search opened (win over `collapsed`). */
  forced?: ReadonlySet<string>
  /** Arrays drawing every item (the "+ N more" row was clicked, or a match sits past the cap). */
  showAll?: ReadonlySet<string>
  /** "Expand all": every branch open, whatever its depth. */
  expandAll?: boolean
}

export type BuildOpts = { collapseDepth: number; arrayCap: number }

export const EMPTY_FOLD: Fold = { collapsed: new Set(), expanded: new Set() }

/** Whether the branch `id` (a card at `depth`) is drawn open. */
export function isOpen(id: string, depth: number, fold: Fold, opts: BuildOpts): boolean {
  if (fold.forced?.has(id)) return true
  if (fold.collapsed.has(id)) return false
  return Boolean(fold.expandAll) || fold.expanded.has(id) || depth <= opts.collapseDepth
}

/**
 * Tree → graph: one card per open object/array (root first, depth-first), a
 * row per key (or item), an edge from each open branch row to its card.
 * Branches past `collapseDepth` start closed; arrays draw `arrayCap` items and
 * a "+ N more" row. Nothing is dropped from the data: closed or capped parts
 * are counted in `collapsed` / `hidden`.
 */
export function buildGraph(
  value: unknown,
  fold: Fold = EMPTY_FOLD,
  opts: BuildOpts = { collapseDepth: COLLAPSE_DEPTH, arrayCap: ARRAY_CAP },
  rootTitle = 'root',
): Graph {
  const nodes: DNode[] = []
  const edges: DEdge[] = []
  const byId = new Map<string, DNode>()
  const hidden: string[] = []
  let collapsed = 0

  const visit = (v: unknown, segs: Seg[], title: string, depth: number, parent?: DNode['parent']): string => {
    const id = pathId(segs)
    const isArr = Array.isArray(v)
    const all: [Seg, unknown][] = isArr
      ? (v as unknown[]).map((x, i) => [i, x])
      : Object.entries((v ?? {}) as Record<string, unknown>)
    const capped = isArr && all.length > opts.arrayCap && !fold.showAll?.has(id)
    const entries = capped ? all.slice(0, opts.arrayCap) : all
    const node: DNode = {
      id,
      segs,
      title,
      kind: isArr ? 'arr' : 'obj',
      count: all.length,
      depth,
      rows: [],
      error: isErrorKey(segs[segs.length - 1]),
      parent,
    }
    nodes.push(node)
    byId.set(id, node)
    for (const [k, x] of entries) {
      const rs = [...segs, k]
      const kind = kindOf(x)
      const row: DRow = { id: pathId(rs), key: String(k), segs: rs, kind, value: x }
      if (kind === 'obj' || kind === 'arr') {
        const n = kind === 'arr' ? (x as unknown[]).length : Object.keys(x as object).length
        row.count = n
        if (isArr) row.preview = previewOf(x)
        if (n > 0) {
          row.open = isOpen(row.id, depth + 1, fold, opts)
          if (row.open) {
            const index = node.rows.length
            const childTitle = isArr ? `${title}[${k}]` : String(k)
            node.rows.push(row)
            row.child = visit(x, rs, childTitle, depth + 1, { node: id, row: index })
            edges.push({ from: id, row: index, to: row.child })
            continue
          }
          collapsed++
        }
      }
      node.rows.push(row)
    }
    if (capped) {
      const total = all.length
      node.rows.push({
        id: `${id}[…]`,
        key: '',
        segs: [...segs],
        kind: 'null',
        value: null,
        more: { array: id, hidden: total - opts.arrayCap, shown: opts.arrayCap, total },
      })
      hidden.push(`${displayPath(segs) || rootTitle}[${opts.arrayCap}…${total - 1}]`)
    }
    return id
  }

  visit(value, [], rootTitle, 0)
  return { nodes, edges, byId, collapsed, hidden }
}

// ── search ────────────────────────────────────────────────────────────────

export type Match = {
  /** The matching row's id (pathId). */
  row: string
  /** The card that holds the row. */
  node: string
  segs: Seg[]
  on: 'key' | 'value' | 'both'
}

/**
 * Every row whose key or value contains `query` (case-insensitive unless
 * `caseSensitive`), in the order the diagram draws them, closed and capped
 * branches included. Array indexes are not matched as keys.
 */
export function searchLine(value: unknown, query: string, caseSensitive = false): Match[] {
  const q = caseSensitive ? query : query.toLowerCase()
  if (!q) return []
  const norm = (s: string) => (caseSensitive ? s : s.toLowerCase())
  const out: Match[] = []
  const walk = (v: unknown, segs: Seg[]) => {
    const isArr = Array.isArray(v)
    const entries: [Seg, unknown][] = isArr
      ? (v as unknown[]).map((x, i) => [i, x])
      : Object.entries((v ?? {}) as Record<string, unknown>)
    // Rows of this card first (as drawn), then its children's cards.
    for (const [k, x] of entries) {
      const kind = kindOf(x)
      const keyHit = typeof k === 'string' && norm(k).includes(q)
      const valHit = kind !== 'obj' && kind !== 'arr' && norm(copyText(x ?? null)).includes(q)
      if (keyHit || valHit) {
        const rs = [...segs, k]
        out.push({
          row: pathId(rs),
          node: pathId(segs),
          segs: rs,
          on: keyHit && valHit ? 'both' : keyHit ? 'key' : 'value',
        })
      }
    }
    for (const [k, x] of entries) {
      const kind = kindOf(x)
      if (kind === 'obj' || kind === 'arr') walk(x, [...segs, k])
    }
  }
  walk(value, [])
  return out
}

/** What has to open so every match is drawn: its ancestor branches, and arrays capping it away. */
export function openFor(matches: readonly Match[], arrayCap: number): { open: Set<string>; showAll: Set<string> } {
  const open = new Set<string>()
  const showAll = new Set<string>()
  for (const m of matches) {
    for (let i = 1; i < m.segs.length; i++) open.add(pathId(m.segs.slice(0, i)))
    for (let i = 0; i < m.segs.length; i++) {
      const s = m.segs[i]
      if (typeof s === 'number' && s >= arrayCap) showAll.add(pathId(m.segs.slice(0, i)))
    }
  }
  return { open, showAll }
}

/** Matches strictly inside the branch `id` (the count a parent row shows). */
export const matchesUnder = (matches: readonly Match[], id: string) =>
  matches.filter((m) => m.row.startsWith(id) && m.row !== id && /^[.[]/.test(m.row.slice(id.length))).length

// ── layout ────────────────────────────────────────────────────────────────

export const LAYOUT = {
  header: 30,
  row: 24,
  /** Extra height per wrapped line. */
  line: 16,
  gapX: 56,
  gapY: 18,
  /** Geist Mono at 12px. */
  charW: 7.25,
  padX: 10,
  /** The −/+ handle sits on the card's right edge. */
  handle: 14,
  minW: 180,
  maxW: 460,
}

export type Direction = 'lr' | 'tb'

export type Box = { x: number; y: number; w: number; h: number; rowY: number[]; rowH: number[] }

export type Layout = {
  boxes: Map<string, Box>
  edges: { key: string; d: string; from: string; to: string; row: number }[]
  width: number
  height: number
}

/** Characters a row needs: `key: value` plus its tags. */
export function rowChars(r: DRow, flowId = false): number {
  if (r.more) return `+ ${r.more.hidden} more · showing ${r.more.shown} of ${r.more.total}`.length
  let n = r.key.length + 2 + valueText(r.value).length
  if (r.preview) n += r.preview.length + 1
  if (flowId) n += 10
  return n
}

export function measureNode(
  node: DNode,
  opts: { wrap: boolean; flowIds?: ReadonlySet<string>; extra?: (r: DRow) => number } = { wrap: false },
): { w: number; h: number; rowH: number[]; rowY: number[] } {
  const L = LAYOUT
  const header = node.title.length + 4 + countLabel(node.kind, node.count).length
  let chars = header
  for (const r of node.rows) chars = Math.max(chars, rowChars(r, opts.flowIds?.has(r.id)) + (opts.extra?.(r) ?? 0))
  const natural = Math.ceil(chars * L.charW + 2 * L.padX + L.handle)
  const w = Math.min(L.maxW, Math.max(L.minW, natural))
  const avail = w - 2 * L.padX - L.handle
  const rowH: number[] = []
  const rowY: number[] = []
  let y = L.header
  for (const r of node.rows) {
    let h = L.row
    if (opts.wrap && !r.more) {
      const lines = Math.ceil((rowChars(r, opts.flowIds?.has(r.id)) * L.charW) / avail)
      if (lines > 1) h += (lines - 1) * L.line
    }
    rowY.push(y)
    rowH.push(h)
    y += h
  }
  return { w, h: y, rowH, rowY }
}

/**
 * Cards in columns by depth (left → right) or bands (top → down). A child sits
 * centred on its parent row when it can, else just below the card above it in
 * its column. Edges are square elbows from the row's handle to the child's header.
 */
export function layoutGraph(
  g: Graph,
  opts: { direction: Direction; wrap: boolean; flowIds?: ReadonlySet<string>; extra?: (r: DRow) => number },
): Layout {
  const L = LAYOUT
  const sizes = new Map(g.nodes.map((n) => [n.id, measureNode(n, opts)]))
  const boxes = new Map<string, Box>()
  const maxDepth = g.nodes.reduce((m, n) => Math.max(m, n.depth), 0)
  const band: number[] = new Array(maxDepth + 1).fill(0)
  for (const n of g.nodes) {
    const s = sizes.get(n.id)
    if (s) band[n.depth] = Math.max(band[n.depth], opts.direction === 'lr' ? s.w : s.h)
  }
  const start: number[] = []
  for (let d = 0; d <= maxDepth; d++) start[d] = d === 0 ? 0 : start[d - 1] + band[d - 1] + L.gapX
  const next: number[] = new Array(maxDepth + 1).fill(Number.NEGATIVE_INFINITY)

  for (const n of g.nodes) {
    const s = sizes.get(n.id)
    if (!s) continue
    const p = n.parent ? boxes.get(n.parent.node) : undefined
    let along: number
    if (opts.direction === 'lr') {
      const desired = p && n.parent ? p.y + p.rowY[n.parent.row] + p.rowH[n.parent.row] / 2 - s.h / 2 : 0
      along = Math.max(desired, next[n.depth])
      boxes.set(n.id, { x: start[n.depth], y: along, w: s.w, h: s.h, rowY: s.rowY, rowH: s.rowH })
      next[n.depth] = along + s.h + L.gapY
    } else {
      const desired = p ? p.x + Math.min(p.w - 40, 24) : 0
      along = Math.max(desired, next[n.depth])
      boxes.set(n.id, { x: along, y: start[n.depth], w: s.w, h: s.h, rowY: s.rowY, rowH: s.rowH })
      next[n.depth] = along + s.w + L.gapY * 2
    }
  }

  // Shift so the top-left card starts at 0, 0.
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  for (const b of boxes.values()) {
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
  }
  let width = 0
  let height = 0
  for (const b of boxes.values()) {
    b.x -= minX
    b.y -= minY
    width = Math.max(width, b.x + b.w)
    height = Math.max(height, b.y + b.h)
  }

  const edges = g.edges.flatMap((e) => {
    const p = boxes.get(e.from)
    const c = boxes.get(e.to)
    if (!p || !c) return []
    const x1 = p.x + p.w
    const y1 = p.y + p.rowY[e.row] + p.rowH[e.row] / 2
    let d: string
    if (opts.direction === 'lr') {
      const y2 = c.y + L.header / 2
      const xm = x1 + L.gapX / 2
      d = `M${x1} ${y1}H${xm}V${y2}H${c.x}`
    } else {
      const x2 = c.x + 20
      const ym = c.y - L.gapX / 2
      d = `M${x1} ${y1}H${x1 + 12}V${ym}H${x2}V${c.y}`
    }
    return [{ key: `${e.from}>${e.to}`, d, from: e.from, to: e.to, row: e.row }]
  })
  return { boxes, edges, width, height }
}

/** Scale and offset that fit `w × h` inside the viewport (never above 100%). */
export function fitView(
  w: number,
  h: number,
  vw: number,
  vh: number,
  pad = 24,
): { zoom: number; x: number; y: number } {
  if (w <= 0 || h <= 0 || vw <= 0 || vh <= 0) return { zoom: 1, x: pad, y: pad }
  const zoom = clampZoom(Math.min(1, (vw - 2 * pad) / w, (vh - 2 * pad) / h))
  return { zoom, x: Math.max(pad, (vw - w * zoom) / 2), y: Math.max(pad, (vh - h * zoom) / 2) }
}

export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 2
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]
export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100))
export function stepZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + 0.001) ?? ZOOM_MAX
  return [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_MIN
}

// ── actions ───────────────────────────────────────────────────────────────

/**
 * The search query for "Filter by value" / "Exclude value": `key:value` on a
 * dotted path (`err.code:X`, which the server walks), or the value as a phrase
 * when the path goes through an array (the search language has no indexes).
 */
export function filterQuery(segs: readonly Seg[], value: unknown, exclude = false): string {
  const neg = exclude ? '-' : ''
  if (segs.length === 0 || hasIndex(segs)) {
    const v = copyText(value).replace(/"/g, '')
    return `${neg}${/\s/.test(v) || !exclude ? `"${v}"` : v}`
  }
  return `${neg}${chip(dottedPath(segs), value)}`
}

// ── settings (this browser) ───────────────────────────────────────────────

export const diagramSettings = z.object({
  direction: z.enum(['lr', 'tb']).catch('lr'),
  collapseDepth: z.number().int().min(1).max(12).catch(COLLAPSE_DEPTH),
  arrayCap: z.number().int().min(1).max(100).catch(ARRAY_CAP),
  wrap: z.boolean().catch(false),
  remember: z.boolean().catch(true),
})
export type DiagramSettings = z.infer<typeof diagramSettings>
export const DEFAULT_SETTINGS: DiagramSettings = {
  direction: 'lr',
  collapseDepth: COLLAPSE_DEPTH,
  arrayCap: ARRAY_CAP,
  wrap: false,
  remember: true,
}

const SETTINGS_KEY = 'quiet.diagram.settings'
const FOLDS_KEY = 'quiet.diagram.folds.'
const MAX_REMEMBERED = 300

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

export function loadSettings(): DiagramSettings {
  try {
    const raw = storage()?.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    return diagramSettings.parse({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) })
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(s: DiagramSettings) {
  try {
    storage()?.setItem(SETTINGS_KEY, JSON.stringify(s))
  } catch {
    // Private mode or full storage: the setting lasts for this visit.
  }
}

/** Branches the user opened or closed, remembered per source (setting "Remember collapsed branches"). */
export function loadFolds(source: string): { collapsed: Set<string>; expanded: Set<string> } {
  try {
    const raw = storage()?.getItem(FOLDS_KEY + source)
    const v = raw ? (JSON.parse(raw) as { collapsed?: unknown; expanded?: unknown }) : {}
    const list = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])
    return { collapsed: new Set(list(v.collapsed)), expanded: new Set(list(v.expanded)) }
  } catch {
    return { collapsed: new Set(), expanded: new Set() }
  }
}

export function saveFolds(source: string, f: { collapsed: ReadonlySet<string>; expanded: ReadonlySet<string> }) {
  try {
    storage()?.setItem(
      FOLDS_KEY + source,
      JSON.stringify({
        collapsed: [...f.collapsed].slice(-MAX_REMEMBERED),
        expanded: [...f.expanded].slice(-MAX_REMEMBERED),
      }),
    )
  } catch {
    // ignore
  }
}

export function forgetFolds(source: string) {
  try {
    storage()?.removeItem(FOLDS_KEY + source)
  } catch {
    // ignore
  }
}
