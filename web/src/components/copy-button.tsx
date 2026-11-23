import { CheckIcon, CopyIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'

/** Copies `text` (the real value, even when the screen shows it masked). */
export function CopyButton({
  text,
  label = 'Copy',
  what,
  variant = 'outline',
  iconOnly = false,
}: {
  text: string
  label?: string
  /** For the toast: `Token copied`. */
  what?: string
  variant?: 'outline' | 'ghost' | 'default'
  /** Just the icon; the label stays as the accessible name. */
  iconOnly?: boolean
}) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setDone(true)
      setTimeout(() => setDone(false), 1500)
      if (what) toast.success(`${what} copied`)
    } catch {
      toast.error('Could not copy', { description: 'Select the text and copy it by hand.' })
    }
  }
  return (
    <Button
      type="button"
      size={iconOnly ? 'icon-sm' : 'sm'}
      variant={variant}
      onClick={copy}
      aria-label={what ? `Copy ${what.toLowerCase()}` : label}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
      {!iconOnly && (done ? 'Copied' : label)}
    </Button>
  )
}
