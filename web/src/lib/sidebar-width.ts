/**
 * Sidebar resize (boards v0.1-03.10 … 03.14, 09.5): the pure part. Widths,
 * the snap-to-hide rule, keyboard steps and what is saved per browser.
 */

export const SIDEBAR_MIN = 200
export const SIDEBAR_DEFAULT = 248
export const SIDEBAR_MAX = 420
/** Releasing a drag below this hides the sidebar; 140–200 holds at 200. */
export const SIDEBAR_SNAP = 140
export const SIDEBAR_STEP = 16
export const SIDEBAR_BIG_STEP = 64
/** The main column keeps at least this much; the sidebar shrinks first. */
export const MAIN_MIN = 720
/** Below this the sidebar is not resizable (mobile layout). */
export const SIDEBAR_DESKTOP = 768

export const WIDTH_KEY = 'quiet.sidebar.width'
export const HIDDEN_KEY = 'quiet.sidebar.hidden'

/** Clamp a width to 200–420; anything that isn't a finite number reads as the default. */
export function clampWidth(w: unknown): number {
  const n = typeof w === 'string' && w.trim() !== '' ? Number(w) : w
  if (typeof n !== 'number' || !Number.isFinite(n)) return SIDEBAR_DEFAULT
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n)))
}

/** Widest the sidebar may be in a window this wide (keeps the main column ≥ 720, never below 200). */
export function maxForViewport(viewport: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, viewport - MAIN_MIN))
}

/** The width actually shown: the saved width, shrunk first when the window is narrow. */
export function effectiveWidth(width: number, viewport: number): number {
  return Math.min(clampWidth(width), maxForViewport(viewport))
}

export type DragState = {
  /** What the sidebar shows while dragging. */
  width: number
  /** Released here, the sidebar hides. */
  hide: boolean
}

/** Where a drag at `raw` px lands: below 140 hides, 140–200 holds at 200, 200–max live. */
export function dragTo(raw: number, viewport = Number.POSITIVE_INFINITY): DragState {
  if (raw < SIDEBAR_SNAP) return { width: SIDEBAR_MIN, hide: true }
  return { width: Math.round(Math.min(maxForViewport(viewport), Math.max(SIDEBAR_MIN, raw))), hide: false }
}

/** The drag tooltip: `264 px` + `default 248`, or `max` / `min` / `default` at those widths, `hide` + `< 140 px` past the snap. */
export function dragLabel(s: DragState): [string, string] {
  if (s.hide) return ['hide', `< ${SIDEBAR_SNAP} px`]
  const sub =
    s.width === SIDEBAR_MAX
      ? 'max'
      : s.width === SIDEBAR_MIN
        ? 'min'
        : s.width === SIDEBAR_DEFAULT
          ? 'default'
          : `default ${SIDEBAR_DEFAULT}`
  return [`${s.width} px`, sub]
}

export type KeyAction = { width: number } | { toggle: true } | null

/** The focused handle: ←/→ 16 px, Shift 64 px, Home/End min/max, Enter hides/shows. */
export function keyAction(key: string, shift: boolean, width: number): KeyAction {
  const step = shift ? SIDEBAR_BIG_STEP : SIDEBAR_STEP
  switch (key) {
    case 'ArrowLeft':
      return { width: clampWidth(width - step) }
    case 'ArrowRight':
      return { width: clampWidth(width + step) }
    case 'Home':
      return { width: SIDEBAR_MIN }
    case 'End':
      return { width: SIDEBAR_MAX }
    case 'Enter':
      return { toggle: true }
    default:
      return null
  }
}

export type SidebarPrefs = { width: number; hidden: boolean }

/** Read the saved width and hidden flag, clamped; bad or missing values → 248, shown. */
export function loadSidebar(storage: Pick<Storage, 'getItem'> | undefined): SidebarPrefs {
  try {
    const w = storage?.getItem(WIDTH_KEY)
    const h = storage?.getItem(HIDDEN_KEY)
    return { width: w == null ? SIDEBAR_DEFAULT : clampWidth(w), hidden: h === 'true' }
  } catch {
    return { width: SIDEBAR_DEFAULT, hidden: false }
  }
}

export function saveSidebar(storage: Pick<Storage, 'setItem'> | undefined, p: SidebarPrefs) {
  try {
    storage?.setItem(WIDTH_KEY, String(clampWidth(p.width)))
    storage?.setItem(HIDDEN_KEY, String(p.hidden))
  } catch {
    // Private mode / quota: the width just isn't remembered.
  }
}
