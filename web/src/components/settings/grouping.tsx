import { Link } from '@tanstack/react-router'
import { ArrowRightIcon, FolderIcon, LockIcon, TerminalIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { GroupIcon } from '@/components/source-group-header'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { GroupingSettings, GroupMode, UpdateGrouping } from '@/gen'
import { useGroupingPreview } from '@/lib/settings-api'
import { useCustomGroups } from '@/lib/source-groups-api'
import { useDebounced } from '@/lib/use-debounced'
import { cn } from '@/lib/utils'

/** A Docker label key: letters, digits, `.`, `-`, `_`, `/`; 1–128 characters (same rule as the server). */
export const validLabel = (k: string) => /^[A-Za-z0-9._/-]{1,128}$/.test(k.trim())

export const draftFrom = (g: GroupingSettings): UpdateGrouping => ({ mode: g.mode, label: g.label })

function Choice({
  value,
  title,
  sub,
  aside,
  selected,
  children,
}: {
  value: GroupMode
  title: string
  sub: ReactNode
  aside?: ReactNode
  selected: boolean
  children?: ReactNode
}) {
  return (
    <div className={cn('border px-4 py-3.5', selected && 'border-brand/70 bg-brand/5')}>
      <div className="flex items-start gap-3">
        <RadioGroupItem id={`group-mode-${value}`} value={value} aria-label={title} className="mt-0.5" />
        <span className="flex flex-1 flex-col gap-0.5">
          <label htmlFor={`group-mode-${value}`} className="cursor-pointer font-medium">
            {title}
          </label>
          <span className="text-muted-foreground text-xs leading-relaxed">{sub}</span>
        </span>
        {aside}
      </div>
      {children}
    </div>
  )
}

/**
 * Settings → General → Source grouping (board v0.1-07.11): Auto · Custom label ·
 * Off, with a live preview of the groups. QUIET_GROUP_BY / QUIET_GROUP_LABEL
 * in the server's environment win and lock the control.
 */
export function SourceGrouping({
  saved,
  draft,
  onChange,
  disabled,
}: {
  saved: GroupingSettings
  draft: UpdateGrouping
  onChange: (d: UpdateGrouping) => void
  disabled: boolean
}) {
  const locked = saved.locked
  const off = disabled || locked
  const label = useDebounced(draft.label.trim(), 250)
  const preview = useGroupingPreview(draft.mode, validLabel(label) ? label : saved.label, true).data
  const labelOk = draft.mode !== 'label' || validLabel(draft.label)
  const custom = useCustomGroups().length

  return (
    <section aria-label="Source grouping" className="flex flex-col gap-3 border-b py-5">
      <div className="flex flex-col gap-1">
        <h3 className="flex items-center gap-2 font-medium">
          Source grouping
          {locked && (
            <span className="flex items-center gap-1 border px-1.5 font-mono text-[10px] text-muted-foreground">
              <LockIcon className="size-3" /> set by env
            </span>
          )}
        </h3>
        <p className="text-muted-foreground text-xs leading-relaxed">
          How the Sources page, the sidebar and the source picker fold sources. HTTP, OTLP, Vector and Fluent Bit pushes
          always sit under Ingest. Streaming stays one source at a time.
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs" data-testid="custom-groups-row">
          <FolderIcon className="size-3.5 shrink-0 text-brand" />
          <span>You can also make your own groups from Sources</span>
          <span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
            · {custom} custom {custom === 1 ? 'group' : 'groups'}
            {custom > 0 && draft.mode === 'off' ? ' · kept while grouping is off' : ''}
          </span>
          <span className="flex-1" />
          <Link to="/sources" className="flex shrink-0 items-center gap-1 text-foreground hover:underline">
            Sources <ArrowRightIcon className="size-3.5" />
          </Link>
        </div>
        {locked && (
          <p className="text-[11px] text-muted-foreground">
            The environment locks the mode only; custom groups stay editable on Sources.
          </p>
        )}
      </div>
      <RadioGroup
        aria-label="Source grouping"
        value={draft.mode}
        onValueChange={(v) => onChange({ ...draft, mode: v as GroupMode })}
        disabled={off}
        className="flex flex-col gap-2"
      >
        <Choice
          value="auto"
          selected={draft.mode === 'auto'}
          title="Auto"
          sub="Compose project (com.docker.compose.project) → Swarm stack (com.docker.stack.namespace) → Standalone. A quiet.group label on a container overrides both."
          aside={<span className="border px-1.5 font-mono text-[10px] text-muted-foreground">default</span>}
        />
        <Choice
          value="label"
          selected={draft.mode === 'label'}
          title="Custom label"
          sub="Group by a Docker label you set on each container."
        >
          {draft.mode === 'label' && (
            <div className="mt-3 grid grid-cols-[1fr_300px] gap-4 pl-7">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="group-label" className="text-xs">
                  Docker label key
                </label>
                <div className="relative">
                  <Input
                    id="group-label"
                    value={draft.label}
                    disabled={off}
                    aria-invalid={!labelOk}
                    placeholder="quiet.group"
                    onChange={(e) => onChange({ ...draft, label: e.target.value })}
                    className="pr-32 font-mono"
                  />
                  {preview && (
                    <span className="absolute top-1.5 right-1.5 border px-1.5 font-mono text-[10px] text-muted-foreground">
                      found on {preview.found} of {preview.docker}
                    </span>
                  )}
                </div>
                <span className={cn('text-xs', labelOk ? 'text-muted-foreground' : 'text-status-err')}>
                  {labelOk
                    ? 'Containers without this label go to Standalone. The label value is the group name.'
                    : 'A Docker label key: letters, digits, . - _ / (up to 128).'}
                </span>
              </div>
              <pre className="border bg-background px-3 py-2.5 font-mono text-[12px] leading-relaxed">
                <span className="text-muted-foreground"># compose.yaml</span>
                {'\n'}
                <span className="text-brand">services:</span>
                {'\n  '}
                <span className="text-brand">payment-worker:</span>
                {'\n    '}
                <span className="text-brand">labels:</span>
                {'\n      '}
                <span className="text-brand">{draft.label.trim() || 'quiet.group'}:</span> payments
              </pre>
            </div>
          )}
        </Choice>
        <Choice
          value="off"
          selected={draft.mode === 'off'}
          title="Off"
          sub="One flat list, no group headers or filters."
        />
      </RadioGroup>

      {preview && draft.mode !== 'off' && (
        <section className="border" aria-label="Grouping preview">
          <div className="flex items-center justify-between border-b px-3 py-2 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
            <span>Preview · {preview.total} sources on this host</span>
            <span className="normal-case tracking-normal">{preview.groups.length} groups · updates as you type</span>
          </div>
          {preview.groups.map((g) => (
            <div
              key={`${g.kind}:${g.name}`}
              className="grid grid-cols-[200px_40px_1fr_auto] items-center gap-3 border-b px-3 py-1.5 font-mono text-xs last:border-b-0"
            >
              <span className="flex items-center gap-2 font-semibold">
                <GroupIcon kind={g.kind} className="size-3" />
                <span className="truncate">{g.name}</span>
              </span>
              <span className="text-muted-foreground">{g.sources.length}</span>
              <span className="truncate text-muted-foreground">{g.sources.join(', ')}</span>
              <span className="text-status-warn">
                {g.kind === 'standalone' && draft.mode === 'label' ? 'no label' : ''}
              </span>
            </div>
          ))}
          {preview.groups.length === 0 && <p className="px-3 py-2 text-muted-foreground text-xs">No sources yet.</p>}
        </section>
      )}

      <p className="flex items-start gap-2 font-mono text-[11px] text-muted-foreground">
        <TerminalIcon className="mt-0.5 size-3 shrink-0" />
        <span>
          env: QUIET_GROUP_BY=auto | label | off QUIET_GROUP_LABEL=quiet.group
          <br />
          {locked
            ? `set in this server's environment (${saved.mode}${saved.mode === 'label' ? ` · ${saved.label}` : ''}), so this control is locked`
            : 'when set in the environment, env wins and this control is locked'}
        </span>
      </p>
    </section>
  )
}
