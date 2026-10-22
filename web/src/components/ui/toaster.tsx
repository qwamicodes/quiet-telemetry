import { Toaster as Sileo } from 'sileo'
import { useTheme } from '@/lib/theme'

/** The quiet surface for toasts: popover fill, square corners, mono-friendly text. */
const FILL = { dark: '#15161a', light: '#ffffff' } as const

/**
 * sileo's Toaster, styled to the quiet look (Lyra: square, hairline, dark first).
 * `roundness: 0` keeps corners square and turns off the gooey blur, which
 * also keeps it cheap. State colours follow the `--status-*` tokens (styles.css).
 */
export function Toaster({ position = 'bottom-right' }: { position?: 'bottom-right' | 'top-right' }) {
  const { theme } = useTheme()
  return (
    <Sileo
      position={position}
      theme={theme}
      options={{
        fill: FILL[theme],
        roundness: 0,
        styles: {
          title: 'normal-case! font-sans!',
          description: 'text-muted-foreground! text-xs!',
          badge: 'rounded-none!',
          button: 'rounded-none! font-mono!',
        },
      }}
    />
  )
}
