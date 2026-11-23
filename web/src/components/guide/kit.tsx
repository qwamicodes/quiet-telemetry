import { CheckIcon, ChevronDownIcon, CopyIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { copyPrompt, STACK_ORDER, type StackId, stackById } from '@/lib/guide'
import { cn } from '@/lib/utils'

/** A bordered card with a title row: the Guide's panels (boards v0.1.1-11.x). */
export function Panel({
  title,
  aside,
  actions,
  sub,
  label,
  className,
  children,
}: {
  title: ReactNode
  aside?: ReactNode
  actions?: ReactNode
  sub?: ReactNode
  label?: string
  className?: string
  children: ReactNode
}) {
  return (
    <section
      aria-label={label ?? (typeof title === 'string' ? title : undefined)}
      className={cn('flex min-w-0 flex-col border bg-card', className)}
    >
      <div className="flex min-h-11 items-center justify-between gap-4 border-b px-3.5 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="font-medium text-[13px]">{title}</span>
          {sub && <span className="truncate font-mono text-[11px] text-muted-foreground">{sub}</span>}
        </div>
        {aside && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{aside}</span>}
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/** The prompt shortcut keys, as on the header buttons. */
export function PromptKeys() {
  return (
    <span className="ml-1 flex gap-0.5" aria-hidden>
      <Kbd>⌘</Kbd>
      <Kbd>⇧</Kbd>
      <Kbd>C</Kbd>
    </span>
  )
}

/** Copy prompt ⌘⇧C; turns into a green "Copied" for a moment (v0.1.0-11.5). */
export function CopyPromptButton({
  stack,
  primary = true,
  keys = true,
  label = 'Copy prompt',
  size,
  onVerify,
}: {
  stack: StackId
  primary?: boolean
  keys?: boolean
  label?: string
  size?: 'sm'
  onVerify?: () => void
}) {
  const [done, setDone] = useState(false)
  return (
    <Button
      type="button"
      size={size}
      variant={done ? 'outline' : primary ? 'default' : 'outline'}
      aria-label={label}
      className={cn(done && 'border-status-ok/60 text-status-ok')}
      onClick={async () => {
        if (await copyPrompt(stack, onVerify)) {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        }
      }}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
      {done ? 'Copied' : label}
      {keys && !done && <PromptKeys />}
    </Button>
  )
}

/** A native select drawn like an input, with a chevron (keeps keyboard and tests simple). */
export function NativeSelect({
  value,
  onChange,
  options,
  label,
  className,
  placeholder,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  label: string
  className?: string
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <span className={cn('relative flex h-9 min-w-0 items-center', className)}>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-full w-full min-w-0 appearance-none border border-input bg-background pr-8 pl-2.5 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:opacity-50',
          !value && 'text-muted-foreground',
        )}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2.5 size-3.5 text-muted-foreground" />
    </span>
  )
}

export const inputCls =
  'h-9 w-full min-w-0 border border-input bg-background px-2.5 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50'

/** A label on the left, the control on the right (the setup rows on 11.1). */
export function FieldRow({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_minmax(0,1fr)] items-center gap-4">
      <label htmlFor={htmlFor} className="text-muted-foreground text-xs">
        {label}
      </label>
      {children}
    </div>
  )
}

/** The language picker (11.1 "Your app", 11.4 "Prompt language"). */
export function StackPicker({
  stack,
  setStack,
  title,
  aside,
  note,
}: {
  stack: StackId
  setStack: (s: StackId) => void
  title: string
  aside: string
  note: string
}) {
  return (
    <Panel title={title} aside={aside}>
      <fieldset className="flex flex-col gap-1.5 p-3" aria-label={title}>
        {STACK_ORDER.map((id) => {
          const x = stackById(id)
          return (
            <label
              key={x.id}
              className={cn(
                'flex cursor-pointer items-center gap-3 border px-3 py-2 text-left hover:bg-accent has-focus-visible:ring-1 has-focus-visible:ring-ring',
                x.id === stack && 'border-brand bg-brand/5',
              )}
            >
              <input
                type="radio"
                name={`guide-stack-${title}`}
                className="sr-only"
                value={x.id}
                checked={x.id === stack}
                onChange={() => setStack(x.id)}
                aria-label={x.label}
              />
              <span className="flex size-6 items-center justify-center border font-mono text-[11px]">{x.letter}</span>
              <span className="flex flex-1 flex-col">
                <span className="text-[13px]">{x.label}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{x.sub}</span>
              </span>
              <span
                className={cn(
                  'size-3.5 rounded-full border',
                  x.id === stack && 'border-brand bg-brand shadow-[inset_0_0_0_3px_var(--card)]',
                )}
              />
            </label>
          )
        })}
        <p className="pt-1 text-muted-foreground text-xs leading-relaxed">{note}</p>
      </fieldset>
    </Panel>
  )
}

/** A tickable list (What happens next, What your agent will do, Done looks like). */
export function Checklist({
  title,
  aside,
  items,
}: {
  title: string
  aside: string
  items: { title: string; sub: string }[]
}) {
  const [done, setDone] = useState<boolean[]>(() => items.map(() => false))
  return (
    <Panel title={title} aside={aside}>
      <ul className="flex flex-col px-3 pb-2">
        {items.map((d, i) => (
          <li key={d.title} className="border-b last:border-b-0">
            <label className="flex cursor-pointer items-start gap-3 py-2.5">
              <input
                type="checkbox"
                className="mt-0.5 accent-[var(--brand)]"
                checked={done[i]}
                onChange={(e) => setDone(done.map((v, j) => (j === i ? e.target.checked : v)))}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={cn('text-[13px]', done[i] && 'text-muted-foreground line-through')}>{d.title}</span>
                {d.sub && <span className="font-mono text-[11px] text-muted-foreground">{d.sub}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

export type AgentStep = 'setup' | 'review' | 'examples' | 'verify'

const STEPS: { id: AgentStep; label: string }[] = [
  { id: 'setup', label: 'Configure' },
  { id: 'review', label: 'Review & copy' },
  { id: 'examples', label: 'Apply in your repo' },
  { id: 'verify', label: 'Verify' },
]

/** Configure · Review & copy · Apply in your repo · Verify. */
export function Stepper({ current, onStep }: { current: AgentStep; onStep: (s: AgentStep) => void }) {
  return (
    <ol className="flex items-center gap-3 text-[13px]" aria-label="Steps">
      {STEPS.map((s, i) => (
        <li key={s.id} className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onStep(s.id)}
            aria-current={s.id === current ? 'step' : undefined}
            className="flex items-center gap-2 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span
              className={cn(
                'flex size-[22px] items-center justify-center border font-mono text-[11px]',
                s.id === current ? 'border-brand text-brand' : 'text-muted-foreground',
              )}
            >
              {i + 1}
            </span>
            <span className={s.id === current ? 'text-foreground' : 'text-muted-foreground'}>{s.label}</span>
          </button>
          {i < STEPS.length - 1 && <span className="h-px w-8 bg-border" />}
        </li>
      ))}
    </ol>
  )
}

/** A dark code block. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        'overflow-x-auto whitespace-pre border bg-code px-3 py-2.5 font-mono text-[12px] leading-[19px]',
        className,
      )}
    >
      {children}
    </pre>
  )
}
