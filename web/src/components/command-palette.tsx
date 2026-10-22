import { useNavigate } from '@tanstack/react-router'
import { CornerDownLeftIcon, GitForkIcon, MoonIcon, SettingsIcon, SunIcon } from 'lucide-react'
import { useState } from 'react'
import { StatusDot } from '@/components/status-dot'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { useSources } from '@/lib/api'
import { isRecent } from '@/lib/format'
import { useTheme } from '@/lib/theme'

/** ⌘K: jump to a source, open a flow by id, or run an action. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const sources = useSources().data ?? []
  const navigate = useNavigate()
  const { theme, toggle } = useTheme()
  const [query, setQuery] = useState('')
  const id = query.trim()

  const run = (fn: () => void) => {
    onOpenChange(false)
    setQuery('')
    fn()
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Jump to"
      description="Sources, flow ids and actions"
      className="sm:max-w-xl"
    >
      <Command>
        <CommandInput placeholder="Jump to a source, paste an id…" value={query} onValueChange={setQuery} />
        <CommandList className="max-h-96">
          <CommandEmpty>Nothing matches.</CommandEmpty>
          {sources.length > 0 && (
            <CommandGroup heading="Sources">
              {sources.map((s) => (
                <CommandItem
                  key={s.name}
                  value={`source ${s.name} ${s.kind}`}
                  onSelect={() => run(() => navigate({ to: '/', search: { source: s.name } }))}
                >
                  <StatusDot status={isRecent(s.last_ts) ? 'ok' : 'idle'} />
                  <span className="font-mono">{s.name}</span>
                  <span className="font-mono text-muted-foreground">{s.kind}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {id.length >= 3 && (
            <CommandGroup heading="Flows by id" forceMount>
              <CommandItem
                value={`flow ${id}`}
                forceMount
                onSelect={() => run(() => navigate({ to: '/flow/$id', params: { id } }))}
              >
                <GitForkIcon />
                <span className="font-mono">{id}</span>
                <CommandShortcut>open flow</CommandShortcut>
              </CommandItem>
            </CommandGroup>
          )}
          <CommandGroup heading="Actions">
            <CommandItem value="switch theme light dark" onSelect={() => run(toggle)}>
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
              Switch to {theme === 'dark' ? 'light' : 'dark'} theme
            </CommandItem>
            <CommandItem value="settings" onSelect={() => run(() => navigate({ to: '/settings' }))}>
              <SettingsIcon />
              Settings
            </CommandItem>
          </CommandGroup>
        </CommandList>
        <div className="flex items-center justify-between border-t px-3 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> move{' '}
            <Kbd className="ml-2">
              <CornerDownLeftIcon />
            </Kbd>{' '}
            open
          </span>
          <span>tip: paste any id to jump straight to its flow</span>
        </div>
      </Command>
    </CommandDialog>
  )
}
