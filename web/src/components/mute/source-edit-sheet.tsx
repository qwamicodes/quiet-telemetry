import { type FormEvent, useState } from 'react'
import { IdOrderEditor } from '@/components/settings/id-order'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import type { SourceSettings } from '@/gen'
import { DEFAULT_SOURCE_SETTINGS, useSaveSource, useSettings } from '@/lib/settings-api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { OWNERS_ONLY } from './rule-bits'
import { SourceMutedLines } from './source-muted-lines'

export type EditTab = 'general' | 'ids' | 'muted'

/**
 * Edit source (06.3, widened to 520px with tabs for 06.13): General ·
 * Flow id order · Muted lines · N. General and Flow id order save with the
 * footer button; muted-lines changes apply right away (Undo in the toast).
 */
export function SourceEditSheet({
  name,
  tab,
  onTab,
  onClose,
  owner,
}: {
  name: string
  tab: EditTab | undefined
  onTab: (t: EditTab) => void
  onClose: () => void
  owner: boolean
}) {
  const data = useSettings().data
  const saved = data?.sources[name] ?? DEFAULT_SOURCE_SETTINGS
  const ownCount = saved.muted.length
  const tabs: [EditTab, string][] = [
    ['general', 'General'],
    ['ids', 'Flow id order'],
    ['muted', `Muted lines · ${ownCount}`],
  ]
  return (
    <Sheet open={tab != null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent width={520} aria-label={`Edit source ${name}`}>
        <SheetHeader title="Edit source" aside={name}>
          <div className="flex gap-1" role="tablist" aria-label="Edit source">
            {tabs.map(([t, label]) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => onTab(t)}
                className={cn(
                  '-mb-px border-transparent border-b-2 px-2.5 py-2 text-muted-foreground text-sm hover:text-foreground',
                  tab === t && 'border-foreground text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </SheetHeader>
        {tab === 'muted' ? (
          <>
            <SheetBody>
              <SourceMutedLines name={name} owner={owner} />
            </SheetBody>
            <SheetFooter>
              <span className="font-mono text-[11px] text-muted-foreground">
                {owner ? 'Rule changes apply right away · Undo in the toast' : OWNERS_ONLY}
              </span>
              <span className="flex-1" />
              <Button onClick={onClose}>
                Done <Kbd>esc</Kbd>
              </Button>
            </SheetFooter>
          </>
        ) : data ? (
          <DraftTab
            key={`${tab}-${JSON.stringify(saved)}`}
            name={name}
            tab={tab ?? 'general'}
            saved={saved}
            globalOrder={data.flow_ids.order}
            owner={owner}
            onClose={onClose}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function DraftTab({
  name,
  tab,
  saved,
  globalOrder,
  owner,
  onClose,
}: {
  name: string
  tab: EditTab
  saved: SourceSettings
  globalOrder: NonNullable<SourceSettings['id_keys']>
  owner: boolean
  onClose: () => void
}) {
  const [draft, setDraft] = useState(saved)
  const save = useSaveSource(name)
  const set = (p: Partial<SourceSettings>) => setDraft((d) => ({ ...d, ...p }))
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    try {
      await save.mutateAsync({ ...draft, display_name: draft.display_name?.trim() || null })
      toast.success(`Saved ${name}`)
      onClose()
    } catch (err) {
      toast.error('Could not save', { description: (err as Error).message })
    }
  }
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
      }}
    >
      <SheetBody>
        <fieldset disabled={!owner} className="flex flex-col gap-5">
          {tab === 'general' ? (
            <>
              <label className="flex flex-col gap-1.5 text-sm">
                Display name
                <Input
                  autoFocus
                  placeholder={name}
                  maxLength={64}
                  value={draft.display_name ?? ''}
                  onChange={(e) => set({ display_name: e.target.value || null })}
                  className="font-mono"
                />
                <span className="text-muted-foreground text-xs">
                  Shown in the sidebar and in flows. Lines keep their original name ({name}).
                </span>
              </label>
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="flex flex-col">
                  <span>Hide from the sidebar</span>
                  <span className="text-muted-foreground text-xs">
                    Still stored, searchable and listed under Sources.
                  </span>
                </span>
                <Switch
                  aria-label="Hide from the sidebar"
                  checked={draft.hidden}
                  onCheckedChange={(v) => set({ hidden: Boolean(v) })}
                />
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-sm">
                <span>Flow id order</span>
                <label className="flex items-center gap-2 text-muted-foreground text-xs">
                  use default
                  <Switch
                    aria-label="Use the instance order"
                    checked={draft.id_keys == null}
                    onCheckedChange={(v) => set({ id_keys: v ? null : [...globalOrder] })}
                  />
                </label>
              </div>
              <IdOrderEditor
                value={draft.id_keys ?? globalOrder}
                onChange={(id_keys) => set({ id_keys })}
                disabled={!owner || draft.id_keys == null}
              />
              <span className="text-muted-foreground text-xs">
                The first id found is the one a row shows; every id still links the line into flows.
              </span>
            </div>
          )}
        </fieldset>
      </SheetBody>
      <SheetFooter>
        {!owner && <span className="font-mono text-[11px] text-muted-foreground">Only owners can edit sources</span>}
        <span className="flex-1" />
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!owner || !dirty || save.isPending}>
          Save <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd>
        </Button>
      </SheetFooter>
    </form>
  )
}
