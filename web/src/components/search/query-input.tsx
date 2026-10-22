import { SearchIcon, XIcon } from 'lucide-react'
import type { Ref } from 'react'
import { cn } from '@/lib/utils'

/** One chip per `key:value` filter, then free text. Enter searches. */
export function QueryInput({
  chips,
  text,
  onText,
  onRemoveChip,
  onSubmit,
  inputRef,
}: {
  chips: string[]
  text: string
  onText: (t: string) => void
  onRemoveChip: (chip: string) => void
  onSubmit: () => void
  inputRef?: Ref<HTMLInputElement>
}) {
  return (
    <div className="flex h-9 min-w-0 flex-1 items-center gap-2 border border-input px-2.5 focus-within:border-brand focus-within:ring-1 focus-within:ring-brand/40">
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      {chips.map((c) => {
        const neg = c.startsWith('-')
        const [k, ...v] = c.replace(/^-/, '').split(':')
        return (
          <span
            key={c}
            className={cn(
              'flex shrink-0 items-center gap-1 border px-1.5 py-0.5 font-mono text-xs',
              neg ? 'border-status-err/30 bg-status-err/10' : 'border-brand/30 bg-brand/10',
            )}
          >
            <span className={neg ? 'text-status-err' : 'text-brand'}>
              {neg ? '-' : ''}
              {k}
            </span>
            <span className="text-muted-foreground">:</span>
            <span>{v.join(':')}</span>
            <button
              type="button"
              aria-label={`Remove ${c}`}
              onClick={() => onRemoveChip(c)}
              className="text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          </span>
        )
      })}
      <input
        ref={inputRef}
        aria-label="Search"
        placeholder={chips.length ? '' : 'Search every line: words, "phrases", key:value'}
        className="h-full min-w-24 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground"
        value={text}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit()
          // Backspace on empty input removes the last chip.
          if (e.key === 'Backspace' && !text && chips.length) onRemoveChip(chips[chips.length - 1])
        }}
      />
      <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground xl:inline">
        free text · key:value · click any value
      </span>
    </div>
  )
}
