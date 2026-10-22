import { Link } from '@tanstack/react-router'
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Caps, PageHeader, ReadOnlyNote, SettingRow } from '@/components/settings/kit'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { FlowIdSettings, IdKey } from '@/gen'
import { isOwner, useMe } from '@/lib/auth-api'
import { ID_KEYS, useSaveFlowIds, useSettings } from '@/lib/settings-api'
import { toast } from '@/lib/toast'

const move = <T,>(xs: T[], i: number, by: number): T[] => {
  const j = i + by
  if (j < 0 || j >= xs.length) return xs
  const out = [...xs]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

/**
 * An ordered list of correlation-id keys: arrows reorder, × stops a key
 * counting, "+ key" brings one back. At least one key stays.
 */
export function IdOrderEditor({
  value,
  onChange,
  disabled,
  share,
}: {
  value: IdKey[]
  onChange: (v: IdKey[]) => void
  disabled?: boolean
  /** Optional right-hand note per key (e.g. `100% of lines`). */
  share?: (k: IdKey) => string | undefined
}) {
  const off = ID_KEYS.filter((k) => !value.includes(k))
  return (
    <div className="flex flex-col gap-1.5">
      <ol className="flex flex-col gap-1.5" aria-label="Correlation id order">
        {value.map((k, i) => (
          <li key={k} className="flex h-10 items-center gap-3 border bg-card px-3">
            <span className="w-4 font-mono text-muted-foreground text-xs">{i + 1}</span>
            <span className="bg-brand/15 px-1.5 py-0.5 font-mono text-brand text-xs">{k}</span>
            <span className="flex-1 font-mono text-[11px] text-muted-foreground">{share?.(k)}</span>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={`Move ${k} up`}
              disabled={disabled || i === 0}
              onClick={() => onChange(move(value, i, -1))}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={`Move ${k} down`}
              disabled={disabled || i === value.length - 1}
              onClick={() => onChange(move(value, i, 1))}
            >
              <ArrowDownIcon />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={`Stop counting ${k}`}
              disabled={disabled || value.length === 1}
              onClick={() => onChange(value.filter((x) => x !== k))}
            >
              <XIcon />
            </Button>
          </li>
        ))}
      </ol>
      {off.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Caps>not counted</Caps>
          {off.map((k) => (
            <Button
              key={k}
              type="button"
              size="xs"
              variant="outline"
              disabled={disabled}
              aria-label={`Count ${k} again`}
              onClick={() => onChange([...value, k])}
            >
              <PlusIcon /> {k}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Settings → Flow id order (board v0.1-07.8): instance order, match by key or value, per-source overrides. */
export function FlowIdOrder() {
  const settings = useSettings().data
  if (!settings) return <p className="text-muted-foreground">Loading…</p>
  return (
    <FlowIdForm
      key={JSON.stringify(settings.flow_ids)}
      saved={settings.flow_ids}
      overrides={Object.entries(settings.sources).filter(([, s]) => s.id_keys != null)}
    />
  )
}

function FlowIdForm({
  saved,
  overrides,
}: {
  saved: FlowIdSettings
  overrides: [string, { id_keys: IdKey[] | null; display_name: string | null }][]
}) {
  const owner = isOwner(useMe())
  const save = useSaveFlowIds()
  const [draft, setDraft] = useState(saved)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const first = draft.order[0]
  const second = draft.order[1]

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await save.mutateAsync(draft)
      toast.success('Flow id order saved', { description: 'New lines and every flow you open use it now.' })
    } catch (err) {
      toast.error('Could not save', { description: (err as Error).message })
    }
  }

  return (
    <form className="flex max-w-3xl flex-col gap-4" onSubmit={submit} aria-label="Flow id order">
      <PageHeader
        title="Flow id order"
        sub="quiet opens a line's flow using the first of these ids it finds. Keys you remove stop counting as correlation ids."
      />
      {!owner && <ReadOnlyNote />}
      <IdOrderEditor value={draft.order} onChange={(order) => setDraft({ ...draft, order })} disabled={!owner} />
      <div className="flex flex-col gap-1 border bg-card px-4 py-3 font-mono text-xs">
        <Caps>How a line is stitched</Caps>
        <span>
          {'{ '}
          {draft.order.slice(0, 2).map((k, i) => (
            <span key={k}>
              {i > 0 && ', '}
              <span className="text-brand">"{k}"</span>: "…"
            </span>
          ))}
          {' , … }'}
        </span>
        <span className="text-muted-foreground">
          → first match wins: the row shows {first}.
          {second && ` ${second} still links the other lines into the same flow.`}
        </span>
      </div>
      <SettingRow
        label="Match ids by"
        hint={
          draft.match_by === 'value'
            ? 'Value: an id links lines whatever key carries it, so a request_id passed on in a job (data.request_id) links the job. Two unrelated keys with the same value (job_id 42, request_id 42) merge.'
            : 'Key: only lines carrying the id under the same key link. Numeric ids stop merging, but a request id copied into a job under another key no longer links.'
        }
      >
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Match ids by"
          disabled={!owner}
          value={[draft.match_by]}
          onValueChange={(v) => v[0] && setDraft({ ...draft, match_by: v[0] as FlowIdSettings['match_by'] })}
        >
          <ToggleGroupItem value="value" aria-label="Value">
            Value
          </ToggleGroupItem>
          <ToggleGroupItem value="key" aria-label="Key">
            Key
          </ToggleGroupItem>
        </ToggleGroup>
      </SettingRow>
      <div className="flex flex-col gap-2">
        <span className="font-medium">Per-source overrides</span>
        {overrides.length === 0 && (
          <p className="text-muted-foreground text-xs">None. Set one from a source's Settings tab.</p>
        )}
        {overrides.map(([name, s]) => (
          <div key={name} className="flex h-10 items-center gap-3 border bg-card px-3">
            <span>{s.display_name ?? name}</span>
            <span className="flex-1 font-mono text-muted-foreground text-xs">{s.id_keys?.join(' → ')}</span>
            <Link
              to="/sources/$name"
              params={{ name }}
              search={{ tab: 'settings' }}
              className="text-xs hover:underline"
            >
              Edit
            </Link>
          </div>
        ))}
      </div>
      {owner && (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={!dirty} onClick={() => setDraft(saved)}>
            Discard
          </Button>
          <Button type="button" variant="ghost" onClick={() => setDraft({ order: [...ID_KEYS], match_by: 'value' })}>
            Reset to default
          </Button>
          <Button type="submit" disabled={!dirty || save.isPending}>
            Save changes
          </Button>
        </div>
      )}
    </form>
  )
}
