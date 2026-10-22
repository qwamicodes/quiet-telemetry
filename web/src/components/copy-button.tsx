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
}: {
  text: string
  label?: string
  /** For the toast: `Token copied`. */
  what?: string
  variant?: 'outline' | 'ghost' | 'default'
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
      size="sm"
      variant={variant}
      onClick={copy}
      aria-label={what ? `Copy ${what.toLowerCase()}` : label}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
      {done ? 'Copied' : label}
    </Button>
  )
}
