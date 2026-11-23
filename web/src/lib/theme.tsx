import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { applyAppearance } from '@/lib/appearance'

/** The theme on screen. */
export type Theme = 'dark' | 'light'
/** What the browser asked for: a theme, or follow the OS (v0.1-07.9). */
export type ThemePref = Theme | 'system'
const KEY = 'quiet.theme'

function stored(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'system' ? v : 'dark'
  } catch {
    return 'dark'
  }
}

const media = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null

const resolve = (pref: ThemePref): Theme => (pref === 'system' ? (media()?.matches ? 'light' : 'dark') : pref)

/** Put the theme class on <html>. index.html ships `class="dark"`, so first paint is already dark. */
function apply(theme: Theme) {
  const root = document.documentElement
  root.classList.remove('dark', 'light')
  root.classList.add(theme)
  root.style.colorScheme = theme
  applyAppearance(theme)
}

const Ctx = createContext<{ theme: Theme; pref: ThemePref; setTheme: (t: ThemePref) => void } | null>(null)

/** Dark by default (Lyra is dark-first); light or System is one choice away. Remembered per browser. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, set] = useState<ThemePref>(stored)
  const [theme, setResolved] = useState<Theme>(() => resolve(stored()))
  useEffect(() => {
    setResolved(resolve(pref))
    if (pref !== 'system') return
    const m = media()
    if (!m) return
    const on = () => setResolved(resolve('system'))
    m.addEventListener?.('change', on)
    return () => m.removeEventListener?.('change', on)
  }, [pref])
  useEffect(() => apply(theme), [theme])
  const setTheme = useCallback((t: ThemePref) => {
    set(t)
    try {
      localStorage.setItem(KEY, t)
    } catch {
      // private mode: keep it for this session only
    }
  }, [])
  const value = useMemo(() => ({ theme, pref, setTheme }), [theme, pref, setTheme])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTheme() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useTheme outside ThemeProvider')
  const { theme, pref, setTheme } = ctx
  return { theme, pref, setTheme, toggle: () => setTheme(theme === 'dark' ? 'light' : 'dark') } as const
}
