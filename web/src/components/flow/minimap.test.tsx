import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlowGraph } from '@/components/flow/flow-graph'
import { minimapMarks } from '@/components/flow/minimap'
import type { Flow, FlowNode } from '@/gen'
import { flowItems } from '@/lib/flow'

const node = (index: number, name: string, extra: Partial<FlowNode> = {}): FlowNode => ({
  index,
  line_id: index + 1,
  source: 'order-worker',
  level: 'info',
  ts: 1000 + index * 10,
  start: 1000 + index * 10,
  duration_ms: 5,
  offset_ms: index * 10,
  name,
  summary: '',
  error: false,
  warn: false,
  attempt: null,
  children: [],
  span_id: null,
  parent: null,
  depth: 0,
  ...extra,
})

// picked_up, 36 × validate_row (row 28 warns, row 30 errors), completed.
const nodes: FlowNode[] = [
  node(0, 'picked_up'),
  ...Array.from({ length: 36 }, (_, i) =>
    node(i + 1, 'validate_row', i === 27 ? { warn: true } : i === 29 ? { error: true, level: 'error' } : {}),
  ),
  node(37, 'completed'),
]
const flow = { nodes, edges: [], lines: [], sources: ['order-worker'] } as unknown as Flow

afterEach(() => vi.restoreAllMocks())

describe('flow minimap (04.3)', () => {
  it('has a tick for every step, even folded ones, and marks errors and warnings', () => {
    const items = flowItems(nodes)
    expect(items.some((i) => i.kind === 'run')).toBe(true)
    const marks = minimapMarks(items, ['order-worker'], null)
    expect(marks).toHaveLength(38)
    expect(marks.filter((m) => m.tone === 'err').map((m) => m.index)).toEqual([30])
    expect(marks.filter((m) => m.tone === 'warn').map((m) => m.index)).toEqual([28])
    // Evenly spread without a layout, in flow order.
    expect(marks.map((m) => m.index)).toEqual(nodes.map((n) => n.index))
    expect(marks[0].y).toBe(0)
  })

  it('is drawn on a long flow, and clicking it scrolls the canvas there', () => {
    const scrollTo = vi.fn()
    Element.prototype.scrollTo = scrollTo as unknown as typeof Element.prototype.scrollTo
    render(<FlowGraph flow={flow} selected={null} onSelect={() => {}} />)
    const map = screen.getByRole('slider', { name: 'Flow minimap' })
    expect(map.querySelectorAll('[data-tone]')).toHaveLength(38)
    expect(map.querySelectorAll('[data-tone="err"]')).toHaveLength(1)
    expect(map.getAttribute('aria-valuetext')).toContain('1 with errors')
    expect(screen.getByTestId('flow-minimap-viewport')).toBeInTheDocument()

    // Fake a laid-out canvas: 2000px of steps in a 500px viewport.
    const grid = map.parentElement?.querySelector<HTMLElement>('.grid') as HTMLElement
    const scroller = grid.parentElement as HTMLElement
    Object.defineProperty(grid, 'offsetHeight', { configurable: true, value: 2000 })
    Object.defineProperty(grid, 'offsetTop', { configurable: true, value: 56 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 })
    vi.spyOn(map, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 232 } as DOMRect)

    // Bottom of the map → the end of the flow, centred.
    fireEvent.pointerDown(map, { clientY: 332, pointerId: 1 })
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 56 + 2000 - 250 })
    // Dragging keeps moving; releasing stops.
    fireEvent.pointerMove(map, { clientY: 216, pointerId: 1 })
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 56 + 1000 - 250 })
    fireEvent.pointerUp(map, { pointerId: 1 })
    fireEvent.pointerMove(map, { clientY: 100, pointerId: 1 })
    expect(scrollTo).toHaveBeenCalledTimes(2)
    // Keyboard: Home goes to the top.
    fireEvent.keyDown(map, { key: 'Home' })
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0 })
  })

  it('is not drawn on a short flow', () => {
    const short = { ...flow, nodes: nodes.slice(0, 3) } as Flow
    render(<FlowGraph flow={short} selected={null} onSelect={() => {}} />)
    expect(screen.queryByRole('slider', { name: 'Flow minimap' })).toBeNull()
  })
})
