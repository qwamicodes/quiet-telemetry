import { EyeIcon, EyeOffIcon } from 'lucide-react'
import { type ComponentProps, useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** A password field with a show/hide toggle. */
export function PasswordInput({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  const [shown, setShown] = useState(false)
  return (
    <div className="relative">
      <Input type={shown ? 'text' : 'password'} className={cn('pr-9 font-mono', className)} {...props} />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground [&_svg]:size-3.5"
      >
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  )
}

export const MIN_PASSWORD = 12

/** 0–4: length first (the server only enforces 12+), variety on top. */
export function passwordScore(p: string): number {
  if (p.length < MIN_PASSWORD) return p.length === 0 ? 0 : 1
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length
  let score = 2
  if (p.length >= 16 || kinds >= 3) score = 3
  if (p.length >= 16 && kinds >= 2) score = 4
  return score
}

const LABEL = ['', 'too short', 'ok', 'good', 'strong']

/** Four bars + `strong · 18 characters`, as on the setup and invite boards. */
export function PasswordMeter({ value }: { value: string }) {
  const score = passwordScore(value)
  return (
    <div className="flex items-center gap-3">
      <div className="flex flex-1 gap-1" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cn('h-0.5 flex-1', i <= score ? (score === 1 ? 'bg-level-error' : 'bg-status-ok') : 'bg-muted')}
          />
        ))}
      </div>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground" aria-live="polite">
        {value ? `${LABEL[score]} · ${value.length} characters` : `at least ${MIN_PASSWORD} characters`}
      </span>
    </div>
  )
}
