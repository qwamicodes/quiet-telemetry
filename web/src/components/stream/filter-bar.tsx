import { FilterIcon, XIcon } from 'lucide-react'
import type { Ref } from 'react'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LEVEL_FILTERS, type LevelFilter } from '@/lib/format'
import { cn } from '@/lib/utils'

const tone: Record<Exclude<LevelFilter, ''>, string> = {
  debug: 'data-[pressed]:bg-level-debug-muted data-[pressed]:text-level-debug',
  info: 'data-[pressed]:bg-level-info-muted data-[pressed]:text-level-info',
  warn: 'data-[pressed]:bg-level-warn-muted data-[pressed]:text-level-warn',
  error: 'data-[pressed]:bg-level-error-muted data-[pressed]:text-level-error',
}

export function FilterBar({
  text,
  onText,
  level,
  onLevel,
  counts,
  inputRef,
}: {
  text: string
  onText: (t: string) => void
  level: LevelFilter
  onLevel: (l: LevelFilter) => void
  counts: Record<string, number>
  inputRef?: Ref<HTMLInputElement>
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 px-6 pt-4 pb-3">
      <InputGroup className="h-8 flex-1">
        <InputGroupAddon>
          <FilterIcon className="size-3.5" />
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          aria-label="Filter text"
          placeholder="Filter text"
          className="font-mono text-xs"
          value={text}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
          }}
        />
        <InputGroupAddon align="inline-end">
          {text ? (
            <InputGroupButton size="icon-xs" aria-label="Clear filter" onClick={() => onText('')}>
              <XIcon />
            </InputGroupButton>
          ) : (
            <Kbd>/</Kbd>
          )}
        </InputGroupAddon>
      </InputGroup>
      {/* Minimum level: pressing `warn` shows warn and above (server-side filter). */}
      <ToggleGroup
        variant="outline"
        size="sm"
        spacing={0}
        aria-label="Minimum level"
        value={level ? [level] : []}
        onValueChange={(v) => onLevel((v[0] as LevelFilter | undefined) ?? '')}
      >
        {LEVEL_FILTERS.map((l) => (
          <Tooltip key={l}>
            <TooltipTrigger
              render={
                <ToggleGroupItem
                  value={l}
                  className={cn('h-8 gap-1.5 px-2.5 font-mono text-xs', tone[l])}
                  aria-label={`${l} and above`}
                />
              }
            >
              {l}
              <span className="text-muted-foreground tabular-nums">{(counts[l] ?? 0).toLocaleString()}</span>
            </TooltipTrigger>
            <TooltipContent>{l === 'error' ? 'Errors only' : `${l} and above`}</TooltipContent>
          </Tooltip>
        ))}
      </ToggleGroup>
    </div>
  )
}
