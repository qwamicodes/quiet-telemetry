import { PanelLeftIcon } from 'lucide-react'
import { type KeyboardEvent, type PointerEvent, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSidebar } from '@/lib/sidebar'
import {
  type DragState,
  dragLabel,
  dragTo,
  keyAction,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SIDEBAR_SNAP,
} from '@/lib/sidebar-width'
import { cn } from '@/lib/utils'

export const SIDEBAR_ID = 'sidebar'

type Drag = {
  id: number
  startX: number
  startW: number
  x: number
  y: number
  top: number
  moved: boolean
  frame: number
  state: DragState
}

const focusToggle = () =>
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-sidebar-toggle]')?.focus())

/**
 * The sidebar's right edge (boards 03.10–03.14): an 8px hit area that shows a
 * 2px accent line + grip on hover (after 150ms), drag and focus. Dragging
 * writes `--sidebar-w` on the shell once per frame (no React render per
 * pointermove) and commits on release: below 140 hides, Esc cancels,
 * double-click resets to 248.
 */
export function SidebarResizeHandle() {
  const { width, setWidth, setHidden } = useSidebar()
  const ref = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const snapRef = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)

  const aside = () => ref.current?.closest<HTMLElement>('[data-slot=app-sidebar]') ?? null
  const root = () => ref.current?.closest<HTMLElement>('[data-sidebar-root]') ?? null
  const setVar = (w: number) => root()?.style.setProperty('--sidebar-w', `${w}px`)

  const paint = () => {
    const d = drag.current
    if (!d) return
    d.frame = 0
    const s = dragTo(d.startW + (d.x - d.startX), window.innerWidth)
    d.state = s
    setVar(s.width)
    ref.current?.setAttribute('aria-valuenow', String(s.width))
    const a = aside()
    if (s.hide) a?.setAttribute('data-snap', '')
    else a?.removeAttribute('data-snap')
    const tip = tipRef.current
    if (tip) {
      const [main, sub] = dragLabel(s)
      ;(tip.children[0] as HTMLElement).textContent = main
      ;(tip.children[1] as HTMLElement).textContent = sub
      tip.style.transform = `translate(${(s.hide ? d.x : s.width) + 16}px, ${d.y + 6}px)`
      tip.hidden = false
    }
    const snap = snapRef.current
    if (snap) {
      snap.hidden = !s.hide
      snap.style.top = `${d.top}px`
      const [, , line, card] = Array.from(snap.children) as HTMLElement[]
      line.style.left = `${d.x - 1}px`
      card.style.top = `${Math.min(d.y + 70, window.innerHeight - 110) - d.top}px`
    }
  }

  const end = (commit: boolean) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    if (d.frame) cancelAnimationFrame(d.frame)
    document.documentElement.removeAttribute('data-sidebar-resizing')
    window.removeEventListener('keydown', onEscape, true)
    ref.current?.removeAttribute('data-dragging')
    aside()?.removeAttribute('data-snap')
    if (tipRef.current) tipRef.current.hidden = true
    if (snapRef.current) snapRef.current.hidden = true
    if (ref.current?.hasPointerCapture(d.id)) ref.current.releasePointerCapture(d.id)
    const s = d.moved ? dragTo(d.startW + (d.x - d.startX), window.innerWidth) : null
    if (commit && s && !s.hide) {
      setVar(s.width)
      setWidth(s.width)
      return
    }
    // Cancelled, a plain click, or hidden: the saved width stays (it reopens there).
    setVar(width)
    ref.current?.setAttribute('aria-valuenow', String(width))
    if (commit && s?.hide) {
      setHidden(true)
      focusToggle()
    }
  }

  // Stable across renders (rates re-render the sidebar mid-drag): the window
  // listener added on pointerdown is the one removed on release.
  const endRef = useRef(end)
  endRef.current = end
  const onEscape = useRef((e: globalThis.KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    endRef.current(false)
  }).current

  // Unmount mid-drag (route change, mobile): don't leave the page in resize mode.
  useEffect(() => () => endRef.current(false), [])

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const rect = aside()?.getBoundingClientRect()
    const startW = Math.round(rect?.width ?? width)
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus({ preventScroll: true })
    drag.current = {
      id: e.pointerId,
      startX: e.clientX,
      startW,
      x: e.clientX,
      y: e.clientY,
      top: rect?.top ?? 0,
      moved: false,
      frame: 0,
      state: { width: startW, hide: false },
    }
    document.documentElement.setAttribute('data-sidebar-resizing', '')
    e.currentTarget.setAttribute('data-dragging', '')
    window.addEventListener('keydown', onEscape, true)
    paint()
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    d.x = e.clientX
    d.y = e.clientY
    if (d.x !== d.startX) d.moved = true
    if (!d.frame) d.frame = requestAnimationFrame(paint)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (drag.current) return
    const a = keyAction(e.key, e.shiftKey, width)
    if (!a) return
    e.preventDefault()
    if ('toggle' in a) {
      setHidden(true)
      focusToggle()
    } else {
      setVar(a.width)
      setWidth(a.width)
    }
  }

  const tipKbd = (
    <KbdGroup>
      <Kbd>⌘</Kbd>
      <Kbd>B</Kbd>
    </KbdGroup>
  )

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable, valued splitter is role=separator (WAI-ARIA window splitter) */}
      <div
        ref={ref}
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-controls={SIDEBAR_ID}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={width}
        title="Drag to resize · double-click to reset"
        data-testid="sidebar-resize"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => end(true)}
        onPointerCancel={() => end(false)}
        onLostPointerCapture={() => end(true)}
        onDoubleClick={() => {
          setVar(SIDEBAR_DEFAULT)
          setWidth(SIDEBAR_DEFAULT)
        }}
        onKeyDown={onKeyDown}
        className="group/handle absolute inset-y-0 -right-1 z-20 hidden w-2 cursor-col-resize touch-none select-none outline-none md:block"
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0.5 w-0.5 bg-brand opacity-0 transition-opacity duration-75 group-hover/handle:opacity-100 group-hover/handle:delay-150 group-focus-visible/handle:opacity-100 group-data-dragging/handle:opacity-100 group-data-dragging/handle:delay-0"
        />
        <span
          aria-hidden
          className="absolute top-[calc(50%-16px)] -left-px flex h-8 w-2 items-center justify-center gap-0.5 border border-brand bg-sidebar opacity-0 transition-opacity duration-75 group-hover/handle:opacity-100 group-hover/handle:delay-150 group-focus-visible/handle:opacity-100 group-focus-visible/handle:shadow-[0_0_0_2px_color-mix(in_oklab,var(--ring)_35%,transparent)] group-data-dragging/handle:opacity-100 group-data-dragging/handle:delay-0"
        >
          <span className="h-3.5 w-px bg-brand" />
          <span className="h-3.5 w-px bg-brand" />
        </span>
      </div>
      {typeof document !== 'undefined' &&
        createPortal(
          <>
            <div
              ref={tipRef}
              hidden
              data-testid="sidebar-resize-tip"
              className="pointer-events-none fixed top-0 left-0 z-[60] flex h-[26px] items-center gap-2 bg-foreground px-2 font-mono text-background shadow-[0_8px_24px_rgba(0,0,0,0.45)] [&[hidden]]:hidden"
            >
              <span className="font-semibold text-xs" />
              <span className="text-[11px] opacity-70" />
            </div>
            <div
              ref={snapRef}
              hidden
              data-testid="sidebar-snap"
              className="pointer-events-none fixed bottom-0 left-0 z-50 [&[hidden]]:hidden"
            >
              <div
                className="absolute inset-y-0 left-0 border-brand border-r border-dashed bg-[color-mix(in_oklab,var(--brand)_10%,transparent)] bg-[repeating-linear-gradient(135deg,color-mix(in_oklab,var(--brand)_16%,transparent)_0_1px,transparent_1px_10px)]"
                style={{ width: SIDEBAR_MIN }}
              />
              <div className="absolute inset-y-0 left-0 w-[3px] bg-brand" />
              <div className="absolute inset-y-0 w-px border-foreground border-l border-dashed opacity-60" />
              <div className="absolute left-3 flex w-44 flex-col gap-1.5 border border-brand bg-popover p-2.5 text-popover-foreground">
                <span className="flex items-center gap-1.5 font-semibold text-xs">
                  <PanelLeftIcon className="size-3.5 text-brand" />
                  Release to hide
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">back past {SIDEBAR_SNAP} cancels</span>
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  {tipKbd}
                  reopens
                </span>
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  )
}

/**
 * Shows the hidden sidebar (left of the top bar, design 03.14). Renders only
 * while the sidebar is hidden; screens with a top bar mount one, and the shell
 * floats its own on screens without.
 */
export function SidebarToggle({ floating = false, className }: { floating?: boolean; className?: string }) {
  const { hidden, setHidden, registerToggle } = useSidebar()
  useEffect(() => (floating ? undefined : registerToggle()), [floating, registerToggle])
  if (!hidden) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-sidebar-toggle
            aria-label="Show sidebar"
            aria-expanded={false}
            aria-controls={SIDEBAR_ID}
            onClick={() => setHidden(false)}
            className={cn(
              'hidden size-7 shrink-0 items-center justify-center border border-border bg-background text-foreground outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 md:flex [&_svg]:size-3.5',
              className,
            )}
          />
        }
      >
        <PanelLeftIcon />
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        Show sidebar
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>B</Kbd>
        </KbdGroup>
      </TooltipContent>
    </Tooltip>
  )
}
