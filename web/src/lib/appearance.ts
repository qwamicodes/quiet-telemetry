import { useCallback, useState } from 'react'

/**
 * Appearance choices kept in this browser (v0.1-07.9). Accent and error-row
 * tint are applied as CSS variables on <html>; density and wrap are read by
 * the stream.
 */
export type Density = 'comfortable' | 'default' | 'compact'
export type Accent = 'periwinkle' | 'green' | 'amber' | 'neutral'

export interface Appearance {
  density: Density
  wrap: boolean
  tintErrors: boolean
  accent: Accent
}

const KEY = 'quiet.appearance'
export const APPEARANCE_DEFAULTS: Appearance = {
  density: 'default',
  wrap: false,
  tintErrors: true,
  accent: 'periwinkle',
}

/** Row height per density, in px. */
export const DENSITY_ROW: Record<Density, number> = { comfortable: 32, default: 28, compact: 24 }

/** Accent swatches: [dark, light] brand colour. Periwinkle is the default `--brand`. */
export const ACCENTS: Record<Accent, { label: string; dark: string; light: string }> = {
  periwinkle: { label: 'Periwinkle', dark: '#8087FF', light: '#4F55E0' },
  green: { label: 'Green', dark: '#3FCF8E', light: '#1F9D63' },
  amber: { label: 'Amber', dark: '#E8B04A', light: '#A86F05' },
  neutral: { label: 'Neutral', dark: '#E8E9EC', light: '#111215' },
}

export function readAppearance(): Appearance {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Appearance>
    return {
      density: v.density && v.density in DENSITY_ROW ? v.density : APPEARANCE_DEFAULTS.density,
      wrap: typeof v.wrap === 'boolean' ? v.wrap : APPEARANCE_DEFAULTS.wrap,
      tintErrors: typeof v.tintErrors === 'boolean' ? v.tintErrors : APPEARANCE_DEFAULTS.tintErrors,
      accent: v.accent && v.accent in ACCENTS ? v.accent : APPEARANCE_DEFAULTS.accent,
    }
  } catch {
    return APPEARANCE_DEFAULTS
  }
}

const currentTheme = (): 'dark' | 'light' => (document.documentElement.classList.contains('light') ? 'light' : 'dark')

/** Set the accent and error-row variables on <html> for the given theme. */
export function applyAppearance(theme: 'dark' | 'light' = currentTheme(), a: Appearance = readAppearance()) {
  if (typeof document === 'undefined') return
  const s = document.documentElement.style
  if (a.accent === 'periwinkle') {
    s.removeProperty('--brand')
    s.removeProperty('--ring')
  } else {
    s.setProperty('--brand', ACCENTS[a.accent][theme])
    s.setProperty('--ring', ACCENTS[a.accent][theme])
  }
  if (a.tintErrors) s.removeProperty('--row-error')
  else s.setProperty('--row-error', 'transparent')
  document.documentElement.dataset.density = a.density
}

export function useAppearance(): [Appearance, (patch: Partial<Appearance>) => void] {
  const [a, setA] = useState<Appearance>(readAppearance)
  const update = useCallback((patch: Partial<Appearance>) => {
    setA((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        // private mode: this session only
      }
      applyAppearance(undefined, next)
      return next
    })
  }, [])
  return [a, update]
}
