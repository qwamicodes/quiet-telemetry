import { Link } from '@tanstack/react-router'
import { ArrowRightIcon, InfoIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { draftFrom, SourceGrouping, validLabel } from '@/components/settings/grouping'
import { PageHeader, ReadOnlyNote, SettingRow } from '@/components/settings/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { GeneralSettings, GroupingSettings, StreamDirection, TimestampFormat } from '@/gen'
import { useHealth } from '@/lib/api'
import { isOwner, useMe } from '@/lib/auth-api'
import { fmtRowTime, fmtTime, publicHost, validTimeZone } from '@/lib/format'
import { useSaveGeneral, useSaveGrouping, useSettings } from '@/lib/settings-api'
import { toast } from '@/lib/toast'

const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {
    return []
  }
})()

/** Line caps are binary: 65536 → `64 KB`, 1048576 → `1 MB`. */
export const fmtLineSize = (b: number) =>
  b >= 1024 * 1024 ? `${+(b / 1024 / 1024).toFixed(1)} MB` : `${+(b / 1024).toFixed(1)} KB`

const LINE_SIZES = [16, 32, 64, 128, 256, 512, 1024].map((k) => k * 1024)

export function validPublicUrl(u: string | null): boolean {
  if (!u?.trim()) return true
  return /^https?:\/\/[^\s/]+(\/\S*)?$/.test(u.trim()) && u.trim().length <= 200
}

/** Settings → General (board v0.1-07.10). */
export function General() {
  const all = useSettings().data
  const health = useHealth().data
  if (!all) return <p className="text-muted-foreground">Loading…</p>
  // Remount the form when the saved values change (after a save or another owner's edit).
  return (
    <GeneralForm
      key={JSON.stringify([all.general, all.grouping, all.muted_search])}
      saved={all.general}
      grouping={all.grouping}
      version={health?.version}
    />
  )
}

function GeneralForm({
  saved,
  grouping,
  version,
}: {
  saved: GeneralSettings
  grouping: GroupingSettings
  version?: string
}) {
  const owner = isOwner(useMe())
  const save = useSaveGeneral()
  const saveGrouping = useSaveGrouping()
  const [draft, setDraft] = useState(saved)
  const [groupDraft, setGroupDraft] = useState(draftFrom(grouping))
  const groupDirty = JSON.stringify(groupDraft) !== JSON.stringify(draftFrom(grouping))
  const groupOk = groupDraft.mode !== 'label' || validLabel(groupDraft.label)
  const generalDirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const dirty = generalDirty || groupDirty
  const nameOk = draft.instance_name.trim().length > 0 && draft.instance_name.trim().length <= 40
  const tzOk = validTimeZone(draft.timezone)
  const urlOk = validPublicUrl(draft.public_url)
  const sample = Date.now() - 2_000

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!nameOk || !tzOk || !urlOk || !groupOk) return
    try {
      if (generalDirty)
        await save.mutateAsync({
          ...draft,
          instance_name: draft.instance_name.trim(),
          public_url: draft.public_url?.trim() || null,
        })
      if (groupDirty && !grouping.locked)
        await saveGrouping.mutateAsync({ ...groupDraft, label: groupDraft.label.trim() })
      toast.success('Settings saved', { description: 'Everyone sees the new values on their next page load.' })
    } catch (err) {
      toast.error('Could not save', { description: (err as Error).message })
    }
  }

  return (
    <form className="max-w-3xl" onSubmit={submit} aria-label="General settings">
      <PageHeader title="General" sub={`Self-hosted at ${publicHost()} · v${version ?? '…'} · single host`} />
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
          label="Public URL"
          hint="Used in invite links and in the snippets on Connect a source. Empty uses the address in your browser."
          htmlFor="public-url"
          under={urlOk ? undefined : 'an http(s) address like https://quiet.example.com'}
        >
          <Input
            id="public-url"
            className="w-70 font-mono text-xs"
            placeholder={window.location.origin}
            value={draft.public_url ?? ''}
            aria-invalid={!urlOk}
            onChange={(e) => setDraft({ ...draft, public_url: e.target.value })}
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
          label="Timestamps"
          hint="How rows show their time. Absolute is easier to match against other tools."
        >
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Timestamps"
            value={[draft.timestamps]}
            onValueChange={(v) => v[0] && setDraft({ ...draft, timestamps: v[0] as TimestampFormat })}
          >
            {(['seconds', 'millis', 'relative'] as const).map((f) => (
              <ToggleGroupItem key={f} value={f} aria-label={f} className="font-mono text-xs">
                {fmtRowTime(sample, f)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingRow>
        <SettingRow label="Max line size" hint="Longer lines are cut and marked truncated in the card.">
          <Select
            value={String(draft.max_line_bytes)}
            onValueChange={(v) => v && setDraft({ ...draft, max_line_bytes: Number(v) })}
          >
            <SelectTrigger aria-label="Max line size" className="w-30">
              <SelectValue>{(v: string) => fmtLineSize(Number(v))}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {[...new Set([...LINE_SIZES, draft.max_line_bytes])]
                .sort((a, b) => a - b)
                .map((b) => (
                  <SelectItem key={b} value={String(b)}>
                    {fmtLineSize(b)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          label="Keep non-JSON lines"
          hint="Plain text lines are kept as raw lines with level info. Off drops them at ingest."
        >
          <Switch
            aria-label="Keep non-JSON lines"
            checked={draft.keep_non_json}
            onCheckedChange={(v) => setDraft({ ...draft, keep_non_json: Boolean(v) })}
          />
        </SettingRow>
        <SettingRow
          label="Include muted lines in search"
          hint="Moved to Settings → Muted lines, with the global rules. Sources still override it."
        >
          <Link to="/settings/muted-lines" className="inline-flex items-center gap-1 text-brand text-sm hover:underline">
            Muted lines <ArrowRightIcon className="size-3.5" />
          </Link>
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
        <SourceGrouping saved={grouping} draft={groupDraft} onChange={setGroupDraft} disabled={!owner} />
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
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty}
            onClick={() => {
              setDraft(saved)
              setGroupDraft(draftFrom(grouping))
            }}
          >
            Discard
          </Button>
          <Button
            type="submit"
            disabled={!dirty || !nameOk || !tzOk || !urlOk || !groupOk || save.isPending || saveGrouping.isPending}
          >
            Save changes
          </Button>
        </div>
      )}
    </form>
  )
}
