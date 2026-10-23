import { describe, expect, it } from 'vitest'
import {
  buildGraph,
  countLabel,
  displayPath,
  filterQuery,
  fitView,
  layoutGraph,
  loadSettings,
  matchesUnder,
  openFor,
  pathId,
  saveSettings,
  searchLine,
  stepZoom,
  valueText,
} from '@/lib/diagram'
import { lineStats, statsLabel } from '@/lib/diagram-stats'
import { checkout } from '@/test/diagram-fixtures'

const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } }
const calls = { calls: Array.from({ length: 14 }, (_, i) => ({ name: `step_${i}`, ok: i % 2 === 0 })) }

describe('tree → graph', () => {
  it('one card per object, root first, edges from the parent row', () => {
    const g = buildGraph(checkout)
    expect(g.nodes.map((n) => n.title)).toEqual(['root', 'wideEvents', 'session', 'error'])
    const root = g.nodes[0]
    expect(root.count).toBe(17)
    expect(root.rows).toHaveLength(17)
    const we = root.rows.findIndex((r) => r.key === 'wideEvents')
    expect(g.edges).toContainEqual({ from: '', row: we, to: '.wideEvents' })
    expect(g.edges).toContainEqual({ from: '.wideEvents', row: 2, to: '.wideEvents.session' })
    expect(g.byId.get('.error')?.error).toBe(true)
    expect(g.byId.get('.wideEvents')?.error).toBe(false)
    expect(g.collapsed).toBe(0)
  })

  it('rows carry kinds and the {n keys} / [n items] labels', () => {
    const root = buildGraph(checkout).nodes[0]
    const by = Object.fromEntries(root.rows.map((r) => [r.key, r]))
    expect(by.level.kind).toBe('num')
    expect(by.should_sample.kind).toBe('bool')
    expect(by.device_id.kind).toBe('str')
    expect(valueText(by.device_id.value)).toBe('""')
    expect(valueText(by.wideEvents.value)).toBe('{7 keys}')
    expect(valueText([1])).toBe('[1 item]')
    expect(countLabel('obj', 0)).toBe('{}')
    expect(by.error.open).toBe(true)
  })

  it('arrays: primitive items are rows, object items get their own card titled key[i]', () => {
    const g = buildGraph({ tags: ['a', 'b'], calls: [{ name: 'auth.verify', ms: 3 }] })
    const root = g.nodes[0]
    expect(root.rows.map((r) => r.key)).toEqual(['tags', 'calls'])
    const tags = g.byId.get('.tags')
    expect(tags?.kind).toBe('arr')
    expect(tags?.rows.map((r) => [r.key, r.value])).toEqual([
      ['0', 'a'],
      ['1', 'b'],
    ])
    const list = g.byId.get('.calls')
    expect(list?.rows[0].preview).toBe('auth.verify')
    expect(g.byId.get('.calls[0]')?.title).toBe('calls[0]')
    expect(displayPath(['calls', 0, 'name'])).toBe('calls[0].name')
  })

  it('caps arrays at 5 items with a "+ N more" row, and shows all on request', () => {
    const g = buildGraph(calls, { collapsed: new Set(), expanded: new Set() }, { collapseDepth: 1, arrayCap: 5 })
    const arr = g.byId.get('.calls')
    expect(arr?.rows).toHaveLength(6)
    expect(arr?.rows[5].more).toEqual({ array: '.calls', hidden: 9, shown: 5, total: 14 })
    expect(g.hidden).toEqual(['calls[5…13]'])
    const all = buildGraph(
      calls,
      { collapsed: new Set(), expanded: new Set(), showAll: new Set(['.calls']) },
      { collapseDepth: 1, arrayCap: 5 },
    )
    expect(all.byId.get('.calls')?.rows).toHaveLength(14)
    expect(all.hidden).toEqual([])
  })

  it('branches past the collapse depth start closed; expand, collapse and expand all win', () => {
    const opts = { collapseDepth: 3, arrayCap: 5 }
    const g = buildGraph(deep, undefined, opts)
    expect(g.nodes.map((n) => n.id)).toEqual(['', '.a', '.a.b', '.a.b.c'])
    expect(g.byId.get('.a.b.c')?.rows[0]).toMatchObject({ key: 'd', open: false, count: 1 })
    expect(g.collapsed).toBe(1)

    const opened = buildGraph(deep, { collapsed: new Set(), expanded: new Set(['.a.b.c.d']) }, opts)
    expect(opened.byId.has('.a.b.c.d')).toBe(true)
    expect(opened.byId.has('.a.b.c.d.e')).toBe(false)

    const closed = buildGraph(deep, { collapsed: new Set(['.a']), expanded: new Set() }, opts)
    expect(closed.nodes.map((n) => n.id)).toEqual([''])

    const all = buildGraph(deep, { collapsed: new Set(), expanded: new Set(), expandAll: true }, opts)
    expect(all.nodes).toHaveLength(6)
    expect(all.collapsed).toBe(0)
  })

  it('empty objects and arrays are rows, not cards', () => {
    const g = buildGraph({ a: {}, b: [] })
    expect(g.nodes).toHaveLength(1)
    expect(g.nodes[0].rows.map((r) => valueText(r.value))).toEqual(['{}', '[]'])
  })
})

describe('stats', () => {
  it('counts keys across objects, objects, depth and bytes', () => {
    const s = lineStats(checkout)
    expect(s.objects).toBe(4)
    expect(s.depth).toBe(2)
    expect(s.keys).toBe(17 + 7 + 2 + 2)
    expect(s.large).toBe(false)
    expect(statsLabel({ ...s, bytes: 812 })).toBe('28 keys · 4 objects · depth 2 · 812 B')
    const big = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, i]))
    expect(lineStats(big).large).toBe(true)
    expect(lineStats({ blob: 'x'.repeat(33 * 1024) }).large).toBe(true)
  })
})

describe('search', () => {
  it('matches keys and values, case-insensitive, in drawing order', () => {
    const m = searchLine(checkout, 'checkout_session')
    expect(m.map((x) => displayPath(x.segs))).toEqual([
      'wideEvents.operation',
      'wideEvents.flow',
      'wideEvents.checkout_session_id',
      'wideEvents.outcome',
      'error.message',
    ])
    expect(m[2].on).toBe('key')
    expect(m[0].on).toBe('value')
    expect(searchLine(checkout, 'checkout_session', true)).toHaveLength(4)
    expect(searchLine(checkout, '')).toEqual([])
  })

  it('opens folded branches and capped arrays that hold a match', () => {
    const m = searchLine(deep, 'f')
    expect(m).toHaveLength(1)
    const { open } = openFor(m, 5)
    expect([...open]).toEqual(['.a', '.a.b', '.a.b.c', '.a.b.c.d', '.a.b.c.d.e'])
    const g = buildGraph(deep, { collapsed: new Set(['.a']), expanded: new Set(), forced: open })
    expect(g.byId.has('.a.b.c.d.e')).toBe(true)

    const hit = searchLine(calls, 'step_12')
    const o = openFor(hit, 5)
    expect([...o.showAll]).toEqual(['.calls'])
    expect(o.open.has('.calls[12]')).toBe(true)
  })

  it('counts matches under a parent row', () => {
    const m = searchLine(checkout, 'checkout_session')
    expect(matchesUnder(m, '.wideEvents')).toBe(4)
    expect(matchesUnder(m, '.error')).toBe(1)
    expect(matchesUnder(m, '.wide')).toBe(0)
  })
})

describe('layout', () => {
  it('left → right: columns by depth, children right of their parent, edges as elbows', () => {
    const l = layoutGraph(buildGraph(checkout), { direction: 'lr', wrap: false })
    const root = l.boxes.get('')
    const we = l.boxes.get('.wideEvents')
    const err = l.boxes.get('.error')
    const session = l.boxes.get('.wideEvents.session')
    if (!root || !we || !err || !session) throw new Error('missing box')
    expect(we.x).toBeGreaterThan(root.x + root.w)
    expect(err.x).toBe(we.x)
    expect(session.x).toBeGreaterThan(we.x + we.w)
    // Cards in one column never overlap.
    expect(err.y).toBeGreaterThanOrEqual(we.y + we.h)
    expect(l.edges).toHaveLength(3)
    expect(l.edges[0].d).toMatch(/^M[\d.]+ [\d.]+H[\d.]+V[\d.]+H[\d.]+$/)
    expect(l.width).toBeGreaterThan(0)
  })

  it('top → down: bands by depth', () => {
    const l = layoutGraph(buildGraph(checkout), { direction: 'tb', wrap: false })
    const root = l.boxes.get('')
    const we = l.boxes.get('.wideEvents')
    expect(we && root && we.y > root.y + root.h).toBe(true)
  })

  it('wrap grows rows with long values', () => {
    const g = buildGraph({ msg: 'x'.repeat(200) })
    const flat = layoutGraph(g, { direction: 'lr', wrap: false }).boxes.get('')
    const wrapped = layoutGraph(g, { direction: 'lr', wrap: true }).boxes.get('')
    expect(wrapped && flat && wrapped.h > flat.h).toBe(true)
  })

  it('fit never zooms past 100% and zoom steps stay in range', () => {
    expect(fitView(400, 300, 1000, 800).zoom).toBe(1)
    expect(fitView(4000, 300, 1000, 800).zoom).toBeLessThan(1)
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1, -1)).toBe(0.9)
    expect(stepZoom(2, 1)).toBe(2)
    expect(stepZoom(0.25, -1)).toBe(0.25)
  })
})

describe('actions and settings', () => {
  it('filter queries use dotted keys, or a phrase through arrays', () => {
    expect(filterQuery(['error', 'name'], 'DomainError')).toBe('error.name:DomainError')
    expect(filterQuery(['status'], 404, true)).toBe('-status:404')
    expect(filterQuery(['calls', 3, 'name'], 'paystack.transfer')).toBe('"paystack.transfer"')
    expect(filterQuery(['calls', 3, 'name'], 'a b', true)).toBe('-"a b"')
  })

  it('pathId is unambiguous between keys and indexes', () => {
    expect(pathId(['a', 0, 'b'])).toBe('.a[0].b')
    expect(pathId([])).toBe('')
  })

  it('settings persist locally and bad values fall back', () => {
    localStorage.clear()
    expect(loadSettings().collapseDepth).toBe(3)
    saveSettings({ direction: 'tb', collapseDepth: 4, arrayCap: 8, wrap: true, remember: false })
    expect(loadSettings()).toEqual({ direction: 'tb', collapseDepth: 4, arrayCap: 8, wrap: true, remember: false })
    localStorage.setItem('quiet.diagram.settings', JSON.stringify({ collapseDepth: -1, direction: 'x' }))
    expect(loadSettings()).toMatchObject({ collapseDepth: 3, direction: 'lr' })
    localStorage.clear()
  })
})
