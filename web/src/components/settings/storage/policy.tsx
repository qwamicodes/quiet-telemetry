import { useEffect, useState } from 'react'
import { StorageFrame } from '@/components/settings/storage/page'
import {
  Callout,
  DBtn,
  Field,
  fmtD,
  fmtDT,
  fmtDYT,
  fmtSize,
  OBtn,
  PBtn,
  StorageHeader,
} from '@/components/settings/storage/ui'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import type { AtCapacity, HistoryPolicy, HistoryPreview } from '@/gen'
import { isOwner, useMe } from '@/lib/auth-api'
import { ConfirmRequired, useHistory, useSetPolicy } from '@/lib/history-api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

// Settings → Storage → Policy (v1.1-10, 11, 28, 29): one policy for every
// connector.

const PRESETS = [7, 30, 90, 365] as const
type Choice = (typeof PRESETS)[number] | 'custom' | 'forever'

const choiceOf = (days: number | null): Choice =>
  days == null ? 'forever' : (PRESETS as readonly number[]).includes(days) ? (days as Choice) : 'custom'

const gbOf = (b: number | null) => (b == null ? '' : String(+(b / 1e9).toFixed(2)))

export function PolicyTab() {
  const owner = isOwner(useMe())
  const h = useHistory().data
  const save = useSetPolicy()
  const p = h?.policy
  const [choice, setChoice] = useState<Choice>(30)
  const [custom, setCustom] = useState('45')
  const [limit, setLimit] = useState('')
  const [atCap, setAtCap] = useState<AtCapacity>('evict')
  const [confirm, setConfirm] = useState<HistoryPreview | null>(null)
  const reset = () => {
    if (!p) return
    setChoice(choiceOf(p.retention_days))
    if (choiceOf(p.retention_days) === 'custom') setCustom(String(p.retention_days))
    setLimit(gbOf(p.size_limit_bytes))
    setAtCap(p.at_capacity)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the saved policy changes
  useEffect(reset, [p?.retention_days, p?.size_limit_bytes, p?.at_capacity])

  const days = choice === 'forever' ? null : choice === 'custom' ? Math.round(Number(custom)) : choice
  const bytes = limit.trim() === '' ? null : Math.round(Number(limit) * 1e9)
  const valid =
    (days == null || (Number.isFinite(days) && days >= 1 && days <= 36_500)) &&
    (bytes == null || (Number.isFinite(bytes) && bytes >= 1e9))
  const dirty = p != null && (days !== p.retention_days || bytes !== p.size_limit_bytes || atCap !== p.at_capacity)

  const submit = async (ok = false) => {
    if (!valid) return toast.error('Check the policy', { description: 'Whole days from 1, and at least 1 GB.' })
    try {
      await save.mutateAsync({
        retention_days: days,
        at_capacity: atCap,
        size_limit_bytes: bytes,
        saved_by: null,
        saved_at: null,
        confirm: ok,
      } satisfies HistoryPolicy & { confirm: boolean })
      setConfirm(null)
      toast.success('Policy saved', { description: 'It applies to every connector.' })
    } catch (err) {
      if (err instanceof ConfirmRequired) return setConfirm(err.preview)
      toast.error('Could not save the policy', { description: (err as Error).message })
    }
  }

  return (
    <StorageFrame
      tab="policy"
      header={<StorageHeader title="Retention policy" sub="One policy for every saved storage connector." />}
    >
      <Callout title="Applies to every connector">
        These settings run on active and inactive connectors. They cover all sources, including newly added sources.
      </Callout>
      <div className="flex flex-col gap-1.5">
        <h3 className="font-medium text-[13px] leading-[18px]">Keep history for</h3>
        <p className="text-muted-foreground text-xs leading-[18px]">
          {choice === 'forever'
            ? 'History has no age limit. Size limits and eviction still apply.'
            : 'Maximum event age. Available history can be shorter when a storage limit is reached.'}
        </p>
      </div>
      <div role="radiogroup" aria-label="Keep history for" className="-mt-1 flex flex-wrap items-center gap-2">
        {[...PRESETS, 'custom' as const, 'forever' as const].map((c) => (
          // biome-ignore lint/a11y/useSemanticElements: preset buttons and radio cards drawn to the board (v1.1-10)
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={choice === c}
            disabled={!owner}
            onClick={() => setChoice(c)}
            className={cn(
              'h-7 border px-3 text-xs leading-4 disabled:opacity-60',
              choice === c
                ? 'border-foreground bg-foreground text-background'
                : 'border-input bg-background hover:bg-muted',
            )}
          >
            {c === 'custom' ? 'Custom' : c === 'forever' ? 'Keep indefinitely' : `${c} days`}
          </button>
        ))}
      </div>
      {choice === 'custom' && (
        <Field
          label="Custom duration"
          inputMode="numeric"
          value={custom}
          disabled={!owner}
          onChange={(e) => setCustom(e.target.value.replace(/[^\d]/g, ''))}
          suffix={<span className="font-mono text-muted-foreground text-xs">days</span>}
          hint="Use a whole number of days. Age is measured from the event’s timestamp."
        />
      )}
      <div className="flex items-start gap-3 border-y py-5">
        <div className="flex flex-1 flex-col gap-1.5">
          <h3 className="font-medium text-[13px] leading-[18px]">Maximum stored history</h3>
          <p className="text-muted-foreground text-xs leading-[18px]">
            The same limit applies separately to each connector’s Quiet data.
          </p>
        </div>
        <Field
          className="w-[200px] shrink-0"
          label="Size limit per connector"
          inputMode="decimal"
          value={limit}
          placeholder="No limit"
          disabled={!owner}
          onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ''))}
          suffix={<span className="font-mono text-muted-foreground text-xs">GB</span>}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <h3 className="font-medium text-[13px] leading-[18px]">When the size limit is reached</h3>
        <p className="text-muted-foreground text-xs leading-[18px]">
          {choice === 'forever'
            ? 'The selected action runs when this size limit is reached.'
            : 'Age-based expiry continues under either policy.'}
        </p>
      </div>
      <div role="radiogroup" aria-label="When the size limit is reached" className="flex flex-col border">
        {(
          [
            ['evict', 'Remove oldest history', 'Remove the oldest stored events to make room for new history.'],
            ['stop', 'Stop adding history', 'Keep stored history. New events continue locally but are not added here.'],
          ] as const
        ).map(([v, title, text]) => (
          // biome-ignore lint/a11y/useSemanticElements: preset buttons and radio cards drawn to the board (v1.1-10)
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={atCap === v}
            disabled={!owner}
            onClick={() => setAtCap(v)}
            className={cn(
              'flex items-center gap-3 border-b p-4 text-left last:border-b-0',
              atCap === v ? 'bg-row-selected' : 'bg-card hover:bg-row-hover',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'size-3 shrink-0 rounded-full border',
                atCap === v ? 'border-brand bg-brand' : 'border-muted-foreground',
              )}
            />
            <span className="flex flex-1 flex-col gap-1.5">
              <span className="font-medium text-xs leading-[18px]">{title}</span>
              <span className="text-muted-foreground text-xs leading-[18px]">{text}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="text-muted-foreground text-xs leading-[18px]">
        Indefinite retention disables age-based expiry; the size limit still applies. Expired history leaves Search
        first; physical cleanup may take longer or be blocked by provider settings.
      </p>
      <div className="flex items-center gap-3">
        <span className="flex-1 font-mono text-muted-foreground text-xs leading-[18px]">
          {p?.saved_at != null
            ? `Last saved · ${p.saved_by ?? 'local'} · ${fmtDT(p.saved_at)}`
            : 'Default policy · not saved yet'}
        </span>
        {owner && (
          <>
            <OBtn onClick={reset} disabled={!dirty || save.isPending}>
              Discard
            </OBtn>
            <PBtn onClick={() => submit(false)} disabled={!dirty || save.isPending}>
              Save policy
            </PBtn>
          </>
        )}
      </div>
      {confirm && p && (
        <ShortenDialog
          preview={confirm}
          from={h?.retained_from ?? null}
          current={p.retention_days}
          next={days}
          pending={save.isPending}
          onCancel={() => setConfirm(null)}
          onApply={() => submit(true)}
        />
      )}
    </StorageFrame>
  )
}

/** v1.1-11: what a shorter window removes from Search, before it is saved. */
function ShortenDialog({
  preview,
  from,
  current,
  next,
  pending,
  onCancel,
  onApply,
}: {
  preview: HistoryPreview
  from: number | null
  current: number | null
  next: number | null
  pending: boolean
  onCancel: () => void
  onApply: () => void
}) {
  const label = (d: number | null) => (d == null ? 'Keep indefinitely' : `${d} days`)
  const n = preview.destinations.filter((d) => d.hours > 0).length
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent showCloseButton={false} className="top-1/2 w-[520px] gap-5 p-6 sm:max-w-[520px]">
        <div className="flex flex-col gap-2">
          <DialogTitle className="font-semibold text-base leading-[22px] tracking-tight">
            Shorten retention to {label(next)}?
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-xs leading-[18px]">
            This changes the shared policy on every saved connector.
          </DialogDescription>
        </div>
        <div className="grid grid-cols-2 border bg-card p-4">
          {(
            [
              ['Current', label(current)],
              ['New', label(next)],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">{k}</span>
              <span className="text-[13px] leading-[18px]">{v}</span>
            </div>
          ))}
        </div>
        {preview.before != null && (
          <p className="font-medium text-[13px] leading-[18px]">
            History before {fmtDYT(preview.before)} will leave Search.
          </p>
        )}
        <p className="font-mono text-muted-foreground text-xs leading-[18px]">
          {from != null && preview.before != null
            ? `${fmtD(from)}–${fmtD(preview.before - 1)}`
            : preview.before != null
              ? `before ${fmtD(preview.before)}`
              : `${preview.hours} hours`}{' '}
          · about {fmtSize(preview.bytes)} across {n} {n === 1 ? 'connector' : 'connectors'}
        </p>
        <p className="text-muted-foreground text-xs leading-5">
          Cleanup will be scheduled in connected storage. Deleted data cannot be recovered by increasing retention
          later.
        </p>
        <div className="flex justify-end gap-3">
          <OBtn onClick={onCancel}>Cancel</OBtn>
          <DBtn onClick={onApply} disabled={pending}>
            Apply shorter retention
          </DBtn>
        </div>
      </DialogContent>
    </Dialog>
  )
}
