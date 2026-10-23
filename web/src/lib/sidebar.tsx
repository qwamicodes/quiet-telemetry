import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { clampWidth, loadSidebar, SIDEBAR_DEFAULT, saveSidebar } from '@/lib/sidebar-width'

export type SidebarState = {
  /** Saved width, 200–420 (what it reopens at). */
  width: number
  /** Hidden on desktop (released below 140, Enter on the handle, ⌘B). */
  hidden: boolean
  setWidth: (w: number) => void
  setHidden: (h: boolean) => void
  toggle: () => void
  /** Top-bar toggles mounted on this screen; with none, the shell shows its own. */
  inlineToggles: number
  registerToggle: () => () => void
}

const noop = () => {}
const SidebarContext = createContext<SidebarState>({
  width: SIDEBAR_DEFAULT,
  hidden: false,
  setWidth: noop,
  setHidden: noop,
  toggle: noop,
  inlineToggles: 0,
  registerToggle: () => noop,
})

export const SidebarProvider = SidebarContext.Provider

const store = () => (typeof window === 'undefined' ? undefined : window.localStorage)

/** One width + hidden flag per browser (localStorage), clamped on load. */
export function useSidebarPrefs(): SidebarState {
  const [prefs, setPrefs] = useState(() => loadSidebar(store()))
  const [inlineToggles, setInline] = useState(0)
  useEffect(() => saveSidebar(store(), prefs), [prefs])
  const setWidth = useCallback((w: number) => setPrefs((p) => ({ ...p, width: clampWidth(w) })), [])
  const setHidden = useCallback((h: boolean) => setPrefs((p) => ({ ...p, hidden: h })), [])
  const toggle = useCallback(() => setPrefs((p) => ({ ...p, hidden: !p.hidden })), [])
  const registerToggle = useCallback(() => {
    setInline((n) => n + 1)
    return () => setInline((n) => n - 1)
  }, [])
  return useMemo(
    () => ({ ...prefs, setWidth, setHidden, toggle, inlineToggles, registerToggle }),
    [prefs, setWidth, setHidden, toggle, inlineToggles, registerToggle],
  )
}

export const useSidebar = () => useContext(SidebarContext)
