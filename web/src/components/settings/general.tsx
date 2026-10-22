import { Link } from '@tanstack/react-router'
import { ArrowRightIcon, InfoIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { PageHeader, ReadOnlyNote, SettingRow } from '@/components/settings/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { GeneralSettings, StreamDirection } from '@/gen'
import { useHealth } from '@/lib/api'
import { isOwner, useMe } from '@/lib/auth-api'
import { fmtTime, validTimeZone } from '@/lib/format'
import { useSaveGeneral, useSettings } from '@/lib/settings-api'
import { toast } from '@/lib/toast'

const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {
    return []
  }
})()

/** Settings → General (board v0.1-07.10): instance name, timezone, stream direction. */
export function General() {
  const saved = useSettings().data?.general
  const health = useHealth().data
  if (!saved) return <p className="text-muted-foreground">Loading…</p>
  // Remount the form when the saved values change (after a save or another owner's edit).
  return <GeneralForm key={JSON.stringify(saved)} saved={saved} version={health?.version} />
}

function GeneralForm({ saved, version }: { saved: GeneralSettings; version?: string }) {
  const owner = isOwner(useMe())
  const save = useSaveGeneral()
  const [draft, setDraft] = useState(saved)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const nameOk = draft.instance_name.trim().length > 0 && draft.instance_name.trim().length <= 40
  const tzOk = validTimeZone(draft.timezone)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!nameOk || !tzOk) return
    try {
      await save.mutateAsync({ ...draft, instance_name: draft.instance_name.trim() })
      toast.success('Settings saved', { description: 'Everyone sees the new values on their next page load.' })
    } catch (err) {
      toast.error('Could not save', { description: (err as Error).message })
    }
  }

  return (
    <form className="max-w-3xl" onSubmit={submit} aria-label="General settings">
      <PageHeader title="General" sub={`Self-hosted at ${window.location.host} · v${version ?? '…'} · single host`} />
      {!owner && <ReadOnlyNote />}
      <fieldset disabled={!owner} className="contents">
        <SettingRow
          label="Instance name"
          hint="Shown in the browser tab, the user menu and on invite links (“Join legivent”)."
          htmlFor="instance-name"
        >
          <Input
            id="instance-name"
            className="w-70"
            value={draft.instance_name}
            maxLength={40}
            aria-invalid={!nameOk}
            onChange={(e) => setDraft({ ...draft, instance_name: e.target.value })}
          />
        </SettingRow>
        <SettingRow
          label="Timezone"
          hint="Used for timestamps in the stream, flows and search. “local” follows each viewer's browser."
          htmlFor="timezone"
          under={tzOk ? `now ${fmtTime(Date.now(), draft.timezone).slice(0, 8)}` : 'unknown zone'}
        >
          <Input
            id="timezone"
            className="w-70 font-mono text-xs"
            list="quiet-timezones"
            value={draft.timezone}
            aria-invalid={!tzOk}
            onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
          />
          <datalist id="quiet-timezones">
            <option value="local" />
            <option value="UTC" />
            {ZONES.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </SettingRow>
        <SettingRow
          label="Stream direction"
          hint="Where the newest line sits, for everyone by default. Each browser can still flip it from the stream."
        >
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Stream direction"
            value={[draft.stream_direction]}
            onValueChange={(v) => v[0] && setDraft({ ...draft, stream_direction: v[0] as StreamDirection })}
          >
            <ToggleGroupItem value="bottom" aria-label="Newest at bottom">
              Newest at bottom
            </ToggleGroupItem>
            <ToggleGroupItem value="top" aria-label="Newest at top">
              Newest at top
            </ToggleGroupItem>
          </ToggleGroup>
        </SettingRow>
      </fieldset>
      <div className="mt-5 flex items-center gap-2 border border-dashed px-4 py-3 text-muted-foreground text-xs">
        <InfoIcon className="size-3.5" />
        <span className="flex-1">How long lines are kept (24h default, up to 7d) and the disk cap live in</span>
        <Link to="/settings/storage" className="flex items-center gap-1 text-foreground hover:underline">
          Storage <ArrowRightIcon className="size-3.5" />
        </Link>
      </div>
      {owner && (
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={!dirty} onClick={() => setDraft(saved)}>
            Discard
          </Button>
          <Button type="submit" disabled={!dirty || !nameOk || !tzOk || save.isPending}>
            Save changes
          </Button>
        </div>
      )}
    </form>
  )
}
