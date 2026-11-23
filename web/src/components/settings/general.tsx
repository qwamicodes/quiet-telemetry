import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { ArrowRightIcon, InfoIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { CustomGroupsRow, draftFrom, SourceGrouping, validLabel } from '@/components/settings/grouping'
import { PageHeader, ReadOnlyNote, SettingRow } from '@/components/settings/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { GeneralSettings, GroupingSettings, GroupMode, TimestampFormat } from '@/gen'
import { useHealth } from '@/lib/api'
import { isOwner, useMe } from '@/lib/auth-api'
import { fmtRowTime, publicHost, validTimeZone } from '@/lib/format'
import { useSaveMutedSearch } from '@/lib/mute-api'
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
      mutedSearch={all.muted_search}
      version={health?.version}
    />
  )
}

/** `Africa/Accra · GMT`; `local` names the browser's zone. */
export function zoneLabel(tz: string): string {
  const zone = tz === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone : tz
  let abbr = ''
  try {
    abbr =
      new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')?.value ?? ''
  } catch {
    return tz
  }
  const name = tz === 'local' ? `local (${zone})` : zone
  return abbr && abbr !== zone ? `${name} · ${abbr}` : name
}

const GROUP_MODES: { value: GroupMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'label', label: 'Custom label' },
  { value: 'off', label: 'Off' },
]

function GeneralForm({
  saved,
  grouping,
  mutedSearch,
  version,
}: {
  saved: GeneralSettings
  grouping: GroupingSettings
  mutedSearch: { include: boolean; origin: string; flag: boolean }
  version?: string
}) {
  const owner = isOwner(useMe())
  const save = useSaveGeneral()
  const saveGrouping = useSaveGrouping()
  const saveMuted = useSaveMutedSearch()
  const { hash } = useLocation()
  const navigate = useNavigate()
  const full = hash === 'grouping'
  const [draft, setDraft] = useState(saved)
  const [groupDraft, setGroupDraft] = useState(draftFrom(grouping))
  const [includeMuted, setIncludeMuted] = useState(mutedSearch.include)
  const groupDirty = JSON.stringify(groupDraft) !== JSON.stringify(draftFrom(grouping))
  const groupOk = groupDraft.mode !== 'label' || validLabel(groupDraft.label)
  const generalDirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const mutedDirty = includeMuted !== mutedSearch.include
  const dirty = generalDirty || groupDirty || mutedDirty
  const nameOk = draft.instance_name.trim().length > 0 && draft.instance_name.trim().length <= 40
  const tzOk = validTimeZone(draft.timezone)
  const urlOk = validPublicUrl(draft.public_url)
  const sample = Date.now() - 2_000
  const zones = [...new Set(['local', 'UTC', draft.timezone, ...ZONES])]

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
      if (mutedDirty) await saveMuted.mutateAsync(includeMuted)
      toast.success('Settings saved', { description: 'Everyone sees the new values on their next page load.' })
    } catch (err) {
      toast.error('Could not save', { description: (err as Error).message })
    }
  }

  const host = `Self-hosted at ${publicHost()} · v${version ?? '…'}`
  return (
    <form className="max-w-190" onSubmit={submit} aria-label="General settings">
      <PageHeader title="General" sub={`${host} · ${full ? 'Source grouping' : 'single host'}`} className="pb-5" />
      {!owner && <ReadOnlyNote />}
      <fieldset disabled={!owner} className="contents">
        {full ? (
          <SourceGrouping saved={grouping} draft={groupDraft} onChange={setGroupDraft} disabled={!owner} />
        ) : (
          <>
            <SettingRow
              label="Instance name"
              hint="Shown in the browser tab and on invite links."
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
              hint="Used in invite links and in the snippets on Connect a source."
              htmlFor="public-url"
              under={urlOk ? undefined : 'an http(s) address like https://quiet.example.com'}
            >
              <Input
                id="public-url"
                className="w-70 font-mono"
                placeholder={window.location.origin}
                value={draft.public_url ?? ''}
                aria-invalid={!urlOk}
                onChange={(e) => setDraft({ ...draft, public_url: e.target.value })}
              />
            </SettingRow>
            <SettingRow label="Timezone" hint="Used for timestamps, the histogram and time ranges.">
              <Select value={draft.timezone} onValueChange={(v) => v && setDraft({ ...draft, timezone: v })}>
                <SelectTrigger aria-label="Timezone" className="w-70" aria-invalid={!tzOk}>
                  <SelectValue>{(v: string) => zoneLabel(v)}</SelectValue>
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  {zones.map((z) => (
                    <SelectItem key={z} value={z}>
                      {zoneLabel(z)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow label="Timestamps" hint="Absolute is easier to match against other tools.">
              <ToggleGroup
                variant="outline"
                size="sm"
                spacing={0}
                aria-label="Timestamps"
                value={[draft.timestamps]}
                onValueChange={(v) => v[0] && setDraft({ ...draft, timestamps: v[0] as TimestampFormat })}
              >
                {(['seconds', 'millis', 'relative'] as const).map((f) => (
                  <ToggleGroupItem key={f} value={f} aria-label={f}>
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
            <SettingRow label="Keep non-JSON lines" hint="Plain text lines are kept as raw lines with level info.">
              <Switch
                aria-label="Keep non-JSON lines"
                checked={draft.keep_non_json}
                onCheckedChange={(v) => setDraft({ ...draft, keep_non_json: Boolean(v) })}
              />
            </SettingRow>
            <SettingRow
              label="Include muted lines in search"
              hint="Muted lines are hidden from the stream and from Search. Turn on to include them in every search. A source can override this; Show muted in Search includes them for one query."
              under={`default ${mutedSearch.flag ? 'on' : 'off'}`}
            >
              <Switch
                aria-label="Include muted lines in search"
                checked={includeMuted}
                onCheckedChange={(v) => setIncludeMuted(Boolean(v))}
              />
            </SettingRow>
            <SettingRow
              label="Source grouping"
              hint={
                <span className="flex flex-col gap-1">
                  <span>
                    {grouping.locked ? 'Set by the server environment. ' : ''}Auto: Compose project → Swarm stack →
                    Standalone. Full options on{' '}
                    <Link to="/settings" hash="grouping" className="underline-offset-2 hover:underline">
                      Source grouping
                    </Link>
                    .
                  </span>
                  <CustomGroupsRow off={groupDraft.mode === 'off'} />
                </span>
              }
            >
              <Select
                value={groupDraft.mode}
                disabled={!owner || grouping.locked}
                onValueChange={(v) => {
                  if (!v) return
                  setGroupDraft({ ...groupDraft, mode: v as GroupMode })
                  if (v === 'label') navigate({ to: '/settings', hash: 'grouping' })
                }}
              >
                <SelectTrigger aria-label="Source grouping" className="w-30">
                  <SelectValue>{(v: string) => GROUP_MODES.find((m) => m.value === v)?.label ?? v}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {GROUP_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Link to="/sources" className="flex items-center gap-1 pt-1 font-medium text-xs hover:underline">
                Sources <ArrowRightIcon className="size-3.5" />
              </Link>
            </SettingRow>
          </>
        )}
      </fieldset>
      {!full && (
        <div className="mt-5 flex items-center gap-2 border border-dashed px-4 py-3 text-muted-foreground text-xs">
          <InfoIcon className="size-3.5" />
          <span>How long lines are kept (24h default, 3d / 7d, 5 GB disk cap) lives in</span>
          <Link to="/settings/storage" className="flex items-center gap-1 font-medium text-foreground hover:underline">
            Storage <ArrowRightIcon className="size-3.5" />
          </Link>
        </div>
      )}
      {owner && (
        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty}
            onClick={() => {
              setDraft(saved)
              setGroupDraft(draftFrom(grouping))
              setIncludeMuted(mutedSearch.include)
            }}
          >
            Discard
          </Button>
          <Button
            type="submit"
            disabled={
              !dirty ||
              !nameOk ||
              !tzOk ||
              !urlOk ||
              !groupOk ||
              save.isPending ||
              saveGrouping.isPending ||
              saveMuted.isPending
            }
          >
            Save changes
          </Button>
        </div>
      )}
    </form>
  )
}
