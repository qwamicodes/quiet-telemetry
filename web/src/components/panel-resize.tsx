import { useCallback, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export interface PanelSize {
  def: number
  min: number
  max: number
  /** localStorage key; the width is remembered per browser. */
  key: string
}

/** The inspector beside a flow (v0.1.1-04.18): 400 px by default, 320–960. */
export const INSPECTOR: PanelSize = { def: 400, min: 320, max: 960, key: 'quiet.flow.inspector.width' }
/** The inspector of a one-event flow, next to its "only one event" note. */
export const INSPECTOR_SINGLE: PanelSize = { def: 640, min: 420, max: 1100, key: 'quiet.flow.inspector.single' }

export function usePanelWidth(size: PanelSize): [number, (w: number) => void] {
  const clamp = useCallback((w: number) => Math.round(Math.min(size.max, Math.max(size.min, w))), [size.max, size.min])
  const [w, setW] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(size.key))
      return v ? clamp(v) : size.def
    } catch {
      return size.def
    }
  })
  const set = useCallback(
    (next: number) => {
      const c = clamp(next)
      setW(c)
      try {
        localStorage.setItem(size.key, String(c))
      } catch {
        // not remembered in private mode
      }
    },
    [clamp, size.key],
  )
  return [w, set]
}

/**
 * A vertical splitter on the left edge of a right-hand panel: drag left to
 * widen, ←/→ 16 px (Shift 64), double-click or Home resets.
 */
export function PanelResize({
  label,
  size,
  width,
  onWidth,
}: {
  label: string
  size: PanelSize
  width: number
  onWidth: (w: number) => void
}) {
  const [drag, setDrag] = useState(false)
  const start = useRef<{ x: number; w: number } | null>(null)
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable splitter; <hr> can't take pointer or key handlers
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={size.min}
      aria-valuemax={size.max}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, w: width }
        setDrag(true)
      }}
      onPointerMove={(e) => {
        if (start.current) onWidth(start.current.w - (e.clientX - start.current.x))
      }}
      onPointerUp={() => {
        start.current = null
        setDrag(false)
      }}
      onDoubleClick={() => onWidth(size.def)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16
        // The panel is on the right: ← widens it.
        if (e.key === 'ArrowLeft') onWidth(width + step)
        else if (e.key === 'ArrowRight') onWidth(width - step)
        else if (e.key === 'Home') onWidth(size.def)
        else return
        e.preventDefault()
      }}
      className="group/panel relative flex w-3 shrink-0 cursor-col-resize touch-none justify-center outline-none"
    >
      <span
        className={cn(
          'h-full w-px bg-transparent group-hover/panel:bg-brand group-focus-visible/panel:bg-brand',
          drag && 'w-0.5 bg-brand',
        )}
      />
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute top-1/2 right-4 hidden whitespace-nowrap border bg-popover px-2 py-1 font-mono text-[11px] shadow-sm',
          'group-hover/panel:block group-focus-visible/panel:block',
          drag && 'block',
        )}
      >
        {width} px · double-click to reset
      </span>
    </div>
  )
}
