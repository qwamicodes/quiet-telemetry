import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FlowItem } from '@/lib/flow'
import { cn } from '@/lib/utils'

/** Height of the minimap track, px (the 04.3 board draws ~230). */
export const MINIMAP_H = 232
const MINIMAP_W = 28

type Tone = 'err' | 'warn' | 'ok'
/** One tick per step node; a folded run draws one tick per step it holds. */
export type MiniMark = { key: string; lane: number; y: number; h: number; tone: Tone; index: number }

/**
 * Where each step sits, as fractions of the canvas height. Measured from the
 * DOM (`[data-mm]` wrappers inside `grid`); without a layout (jsdom, first
 * paint) the steps are spread evenly so the map still reads.
 */
export function minimapMarks(items: FlowItem[], lanes: string[], grid: HTMLElement | null): MiniMark[] {
  const total = grid?.offsetHeight ?? 0
  const out: MiniMark[] = []
  const count = items.reduce((n, it) => n + (it.kind === 'run' ? it.nodes.length : 1), 0) || 1
  let seq = 0
  for (const it of items) {
    const key = it.kind === 'run' ? it.key : `n${it.node.index}`
    const el = total > 0 ? grid?.querySelector<HTMLElement>(`[data-mm="${CSS.escape(key)}"]`) : null
    const nodes = it.kind === 'run' ? it.nodes : [it.node]
    const lane = Math.max(0, lanes.indexOf(nodes[0].source))
    const top = el ? el.offsetTop / total : seq / count
    const height = el ? el.offsetHeight / total : nodes.length / count
    const each = height / nodes.length
    nodes.forEach((n, i) => {
      out.push({
        key: `${key}:${i}`,
        lane,
        y: top + each * i,
        h: each,
        tone: n.error ? 'err' : n.warn ? 'warn' : 'ok',
        index: n.index,
      })
    })
    seq += nodes.length
  }
  return out
}

/** What part of the canvas is on screen, as fractions of its height. */
function viewportOf(scroller: HTMLElement, grid: HTMLElement, zoom: number): { top: number; height: number } {
  const h = grid.offsetHeight * zoom
  if (h <= 0 || scroller.clientHeight <= 0) return { top: 0, height: 1 }
  const height = Math.min(1, scroller.clientHeight / h)
  const top = (scroller.scrollTop - grid.offsetTop) / h
  return { top: Math.max(0, Math.min(1 - height, top)), height }
}

/**
 * The 04.3 minimap: every step of a long flow as a tick (errors red, warnings
 * amber), a box for the part on screen, click or drag to move the canvas,
 * arrow keys / PageUp / PageDown / Home / End when focused.
 */
export function FlowMinimap({
  items,
  lanes,
  scrollRef,
  gridRef,
  zoom,
}: {
  items: FlowItem[]
  lanes: string[]
  scrollRef: RefObject<HTMLDivElement | null>
  gridRef: RefObject<HTMLDivElement | null>
  zoom: number
}) {
  const [marks, setMarks] = useState<MiniMark[]>(() => minimapMarks(items, lanes, null))
  const [view, setView] = useState({ top: 0, height: 1 })
  const dragging = useRef(false)
  const trackRef = useRef<HTMLDivElement>(null)

  const measure = useCallback(() => {
    const grid = gridRef.current
    const scroller = scrollRef.current
    setMarks(minimapMarks(items, lanes, grid))
    if (grid && scroller) setView(viewportOf(scroller, grid, zoom))
  }, [items, lanes, gridRef, scrollRef, zoom])

  useLayoutEffect(measure, [measure])

  useEffect(() => {
    const scroller = scrollRef.current
    const grid = gridRef.current
    if (!scroller || !grid) return
    const onScroll = () => setView(viewportOf(scroller, grid, zoom))
    scroller.addEventListener('scroll', onScroll, { passive: true })
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(grid)
    ro?.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      ro?.disconnect()
    }
  }, [scrollRef, gridRef, zoom, measure])

  /** Centre the canvas on `frac` of its height. */
  const goTo = useCallback(
    (frac: number) => {
      const scroller = scrollRef.current
      const grid = gridRef.current
      if (!scroller || !grid) return
      const f = Math.max(0, Math.min(1, frac))
      const top = grid.offsetTop + f * grid.offsetHeight * zoom - scroller.clientHeight / 2
      scroller.scrollTo({ top: Math.max(0, top) })
      setView(viewportOf(scroller, grid, zoom))
    },
    [scrollRef, gridRef, zoom],
  )

  const fracAt = (clientY: number) => {
    const r = trackRef.current?.getBoundingClientRect()
    if (!r || r.height <= 0) return 0
    return (clientY - r.top) / r.height
  }

  const laneW = (MINIMAP_W - 6) / Math.max(1, lanes.length)
  const errors = marks.filter((m) => m.tone === 'err').length
  const pct = Math.round(view.top * 100)

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="Flow minimap"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${marks.length} steps${errors ? ` · ${errors} with errors` : ''} · at ${pct}%`}
      title="Minimap · click or drag to move"
      data-testid="flow-minimap"
      className="absolute top-14 right-3 z-10 cursor-pointer touch-none border bg-popover/90 outline-none focus-visible:ring-2 focus-visible:ring-brand"
      style={{ width: MINIMAP_W, height: MINIMAP_H }}
      onPointerDown={(e) => {
        dragging.current = true
        e.currentTarget.setPointerCapture?.(e.pointerId)
        goTo(fracAt(e.clientY))
      }}
      onPointerMove={(e) => {
        if (dragging.current) goTo(fracAt(e.clientY))
      }}
      onPointerUp={(e) => {
        dragging.current = false
        e.currentTarget.releasePointerCapture?.(e.pointerId)
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
      onKeyDown={(e) => {
        const mid = view.top + view.height / 2
        const step = { ArrowDown: 0.05, ArrowUp: -0.05, PageDown: view.height, PageUp: -view.height }[e.key]
        if (step !== undefined) goTo(mid + step)
        else if (e.key === 'Home') goTo(0)
        else if (e.key === 'End') goTo(1)
        else return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {marks.map((m) => (
        <span
          key={m.key}
          data-tone={m.tone}
          className={cn(
            'pointer-events-none absolute',
            m.tone === 'err' ? 'bg-status-err' : m.tone === 'warn' ? 'bg-status-warn' : 'bg-muted-foreground/45',
          )}
          style={{
            left: 3 + m.lane * laneW + 1,
            width: Math.max(2, laneW - 2),
            top: 2 + m.y * (MINIMAP_H - 4),
            height: Math.max(m.tone === 'ok' ? 1 : 2, m.h * (MINIMAP_H - 4) - 1.5),
          }}
        />
      ))}
      <span
        aria-hidden
        data-testid="flow-minimap-viewport"
        className="pointer-events-none absolute inset-x-0 border border-brand bg-brand/10"
        style={{ top: view.top * MINIMAP_H, height: Math.max(8, view.height * MINIMAP_H) }}
      />
    </div>
  )
}
