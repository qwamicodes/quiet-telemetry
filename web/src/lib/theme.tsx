import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'

export type Theme = 'dark' | 'light'
const KEY = 'quiet.theme'

function stored(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/** Put the theme class on <html>. index.html ships `class="dark"`, so first paint is already dark. */
function apply(theme: Theme) {
  const root = document.documentElement
  root.classList.remove('dark', 'light')
  root.classList.add(theme)
  root.style.colorScheme = theme
}

const Ctx = createContext<{ theme: Theme; setTheme: (t: Theme) => void } | null>(null)

/** Dark by default (Lyra is dark-first); light is one toggle away. Remembered per browser. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, set] = useState<Theme>(stored)
  useEffect(() => apply(theme), [theme])
  const setTheme = useCallback((t: Theme) => {
    set(t)
    try {
      localStorage.setItem(KEY, t)
    } catch {
      // private mode: keep it for this session only
    }
  }, [])
  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTheme() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useTheme outside ThemeProvider')
  const { theme, setTheme } = ctx
  return { theme, setTheme, toggle: () => setTheme(theme === 'dark' ? 'light' : 'dark') } as const
}
