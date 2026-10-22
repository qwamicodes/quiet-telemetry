import { ArrowDownToLineIcon, ArrowUpToLineIcon, FilterIcon, WrapTextIcon, XIcon } from 'lucide-react'
import type { Ref } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { LevelTally } from '@/gen'
import { LEVEL_FILTERS } from '@/lib/format'
import { isOn, type LevelChip } from '@/lib/levels'
import { cn } from '@/lib/utils'

const tone: Record<LevelChip, string> = {
  debug: 'bg-level-debug-muted text-level-debug border-level-debug/30',
  info: 'bg-level-info-muted text-level-info border-level-info/30',
  warn: 'bg-level-warn-muted text-level-warn border-level-warn/30',
  error: 'bg-level-error-muted text-level-error border-level-error/30',
}

/** One `key:value` chip: key coloured, `-` negated in red, operators kept (`status:≥400`). */
export function FilterChip({ chip, onRemove }: { chip: string; onRemove?: () => void }) {
  const neg = chip.startsWith('-')
  const body = neg ? chip.slice(1) : chip
  const i = body.indexOf(':')
  const key = body.slice(0, i)
  const value = body
    .slice(i + 1)
    .replace(/^>=/, '≥')
    .replace(/^<=/, '≤')
    .replace(/^"|"$/g, '')
  return (
    <span
      data-testid="filter-chip"
      className={cn(
        'flex h-6 shrink-0 items-center gap-1 border px-1.5 font-mono text-xs',
        neg ? 'border-status-err/30 bg-status-err/10' : 'border-brand/30 bg-brand/10',
      )}
    >
      <span className={neg ? 'text-status-err' : 'text-brand'}>
        {neg ? '-' : ''}
        {key}
      </span>
      <span className="text-muted-foreground">:</span>
      <span>{value}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${chip}`}
          onClick={onRemove}
          className="text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3" />
        </button>
      )}
    </span>
  )
}

function IconToggle({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string
  pressed?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            onClick={onClick}
            className="flex size-8 shrink-0 items-center justify-center border text-muted-foreground hover:bg-muted hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground [&_svg]:size-3.5"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Chips (`status:≥400`, `-path:/health`; click any value in a row to add one),
 * free text, multi-select level chips with the window's counts, the view
 * (newest at bottom / top) and wrap.
 */
export function FilterBar({
  chips,
  text,
  onText,
  onRemoveChip,
  onSubmitChip,
  levels,
  onToggleLevel,
  counts,
  inputRef,
  direction,
  onDirection,
  wrap,
  onWrap,
}: {
  chips: string[]
  text: string
  onText: (t: string) => void
  onRemoveChip: (c: string) => void
  /** Enter on a typed `key:value` turns it into a chip. */
  onSubmitChip: (c: string) => void
  levels: LevelChip[]
  onToggleLevel: (l: LevelChip) => void
  counts: LevelTally | null
  inputRef?: Ref<HTMLInputElement>
  direction?: 'bottom' | 'top'
  onDirection?: (d: 'bottom' | 'top') => void
  wrap: boolean
  onWrap: (w: boolean) => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 px-6 pt-4 pb-3">
      <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 border border-input px-2 focus-within:border-brand focus-within:ring-1 focus-within:ring-brand/40">
        <FilterIcon className="size-3.5 shrink-0 text-muted-foreground" />
        {chips.map((c) => (
          <FilterChip key={c} chip={c} onRemove={() => onRemoveChip(c)} />
        ))}
        <input
          ref={inputRef}
          aria-label="Filter text"
          placeholder="Filter text, or click any value in a row"
          className="h-full min-w-24 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground"
          value={text}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            const t = e.currentTarget.value.trim()
            if (e.key === 'Enter' && /^-?[^\s:/"]+:\S+$/.test(t)) {
              onSubmitChip(t)
              onText('')
            }
            if (e.key === 'Backspace' && !e.currentTarget.value && chips.length) onRemoveChip(chips[chips.length - 1])
            if (e.key === 'Escape') e.currentTarget.blur()
          }}
        />
        {text || chips.length ? (
          <button
            type="button"
            aria-label="Clear filter"
            onClick={() => {
              onText('')
              for (const c of chips) onRemoveChip(c)
            }}
            className="text-muted-foreground hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : (
          <Kbd>/</Kbd>
        )}
      </div>
      {/* Multi-select: any combination of levels; all on = no level filter. */}
      <fieldset aria-label="Levels" className="m-0 flex shrink-0 border-0 p-0">
        {LEVEL_FILTERS.map((l, i) => {
          const on = isOn(levels, l)
          return (
            <Tooltip key={l}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-pressed={on}
                    aria-label={`${l} lines`}
                    onClick={() => onToggleLevel(l)}
                    className={cn(
                      'flex h-8 items-center gap-1.5 border px-2.5 font-mono text-xs',
                      i > 0 && '-ml-px',
                      on ? tone[l] : 'text-muted-foreground/70 hover:text-foreground',
                    )}
                  />
                }
              >
                {l}
                <span className={cn('tabular-nums', on ? 'opacity-70' : 'opacity-60')}>
                  {counts ? counts[l].toLocaleString() : '–'}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {on ? 'Hide' : 'Show'} {l} lines · {i + 1}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </fieldset>
      {direction && onDirection && (
        <IconToggle
          label={direction === 'bottom' ? 'Newest at bottom' : 'Newest at top'}
          onClick={() => onDirection(direction === 'bottom' ? 'top' : 'bottom')}
        >
          {direction === 'bottom' ? <ArrowDownToLineIcon /> : <ArrowUpToLineIcon />}
        </IconToggle>
      )}
      <IconToggle label={wrap ? 'Wrap long lines: on' : 'Wrap long lines'} pressed={wrap} onClick={() => onWrap(!wrap)}>
        <WrapTextIcon />
      </IconToggle>
    </div>
  )
}
