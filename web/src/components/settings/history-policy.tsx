import { ArchiveIcon, RotateCcwIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { Caps } from '@/components/settings/kit'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { AtCapacity, HistoryJob, HistoryPreview, HistoryStatus } from '@/gen'
import { fmtBytes, fmtCount, fmtDay } from '@/lib/format'
import {
  ConfirmRequired,
  RETENTION_CHOICES,
  retentionLabel,
  useBackfill,
  useJobAction,
  useSetPolicy,
} from '@/lib/history-api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

// Settings → Storage → Retained history, part 2 (v0.1.1 Phase 5b): how long
// history is kept, what happens when a destination is full, background jobs
// and the backfill offer. Built from docs/v0.1.1-storage-design.md; compare
// with the "v1.1 storage & retention" boards once Paper is open.

function choiceOf(days: number | null): string {
  if (days == null) return 'forever'
  return RETENTION_CHOICES.find((c) => c.days === days)?.value ?? 'custom'
}

/** "deletes 214 hours · 38 GB from production-r2 and garage-local". */
export function previewSentence(p: HistoryPreview): string {
  const names = p.destinations.map((d) => d.name)
  const where = names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return `deletes ${fmtCount(p.hours)} hour${p.hours === 1 ? '' : 's'} · ${fmtBytes(p.bytes)} from ${where}`
}

/** Keep history for · When a destination is full · the cleanup in progress. */
export function HistoryPolicyRows({ h, owner }: { h: HistoryStatus; owner: boolean }) {
  const set = useSetPolicy()
  const days = h.policy.retention_days
  const [choice, setChoice] = useState(choiceOf(days))
  const [custom, setCustom] = useState(days != null && choiceOf(days) === 'custom' ? String(days) : '')
  const [confirm, setConfirm] = useState<{ days: number | null; preview: HistoryPreview } | null>(null)

  const save = async (retention: number | null, atCapacity: AtCapacity, confirmed = false) => {
    try {
      await set.mutateAsync({ retention_days: retention, at_capacity: atCapacity, confirm: confirmed })
      setConfirm(null)
      toast.success(`History is kept ${retentionLabel(retention)}`)
    } catch (err) {
      if (err instanceof ConfirmRequired) {
        setConfirm({ days: retention, preview: err.preview })
        return
      }
      toast.error('Could not save it', { description: (err as Error).message })
    }
  }
  const pick = (v: string) => {
    setChoice(v)
    if (v === 'custom') return
    const c = RETENTION_CHOICES.find((x) => x.value === v)
    save(c?.days ?? null, h.policy.at_capacity)
  }
  const customDays = Number(custom)
  const customOk = Number.isInteger(customDays) && customDays >= 1 && customDays <= 36_500

  return (
    <div className="flex flex-col border-t">
      <div className="flex items-center justify-between gap-6 px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-sm">Keep history for</span>
          <span className="text-muted-foreground text-xs">
            Every destination. Older archived hours are deleted; the local window is unaffected.
          </span>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            value={[choice]}
            onValueChange={(v) => v[0] && pick(v[0])}
            aria-label="Keep history for"
            disabled={!owner || set.isPending}
          >
            {RETENTION_CHOICES.map((c) => (
              <ToggleGroupItem key={c.value} value={c.value} className="px-2.5">
                {c.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {choice === 'custom' && owner && (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                if (customOk) save(customDays, h.policy.at_capacity)
              }}
            >
              <Input
                aria-label="Days to keep history"
                inputMode="numeric"
                className="h-7 w-20 font-mono text-xs"
                value={custom}
                onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="days"
              />
              <span className="text-muted-foreground text-xs">days</span>
              <Button size="xs" type="submit" disabled={!customOk || set.isPending}>
                Apply
              </Button>
            </form>
          )}
          <span className="font-mono text-[11px] text-muted-foreground">
            {h.retained_from != null ? `kept from ${fmtDay(h.retained_from)}` : 'kept indefinitely · default'}
            {h.expired_hours > 0 &&
              ` · deleting ${fmtCount(h.expired_hours)} expired hour${h.expired_hours === 1 ? '' : 's'} (${fmtBytes(h.expired_bytes)})`}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-6 border-t px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-sm">When a destination is full</span>
          <span className="text-muted-foreground text-xs">
            Its capacity is the one set on it, or the Garage bucket quota.
          </span>
        </div>
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          value={[h.policy.at_capacity]}
          onValueChange={(v) => v[0] && save(days, v[0] as AtCapacity)}
          aria-label="When a destination is full"
          disabled={!owner || set.isPending}
        >
          <ToggleGroupItem value="evict" className="px-2.5">
            Evict oldest
          </ToggleGroupItem>
          <ToggleGroupItem value="stop" className="px-2.5">
            Stop archiving
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <Dialog
        open={confirm != null}
        onOpenChange={(o) => {
          if (!o) {
            setConfirm(null)
            setChoice(choiceOf(days))
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keep history {confirm ? retentionLabel(confirm.days) : ''}?</DialogTitle>
            <DialogDescription>
              This {confirm ? previewSentence(confirm.preview) : ''}
              {confirm?.preview.before != null && `: every archived hour before ${fmtDay(confirm.preview.before)}`}.
              Deleting runs in the background and can't be undone. The local window is not affected.
            </DialogDescription>
          </DialogHeader>
          {confirm && (
            <ul className="flex flex-col gap-1 font-mono text-xs">
              {confirm.preview.destinations.map((d) => (
                <li key={d.id} className="flex justify-between border-b py-1 last:border-b-0">
                  <span>{d.name}</span>
                  <span className="text-muted-foreground">
                    {fmtCount(d.hours)} h · {fmtBytes(d.bytes)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={set.isPending}
              onClick={() => confirm && save(confirm.days, h.policy.at_capacity, true)}
            >
              Delete {confirm ? fmtCount(confirm.preview.hours) : ''} hours
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

const JOB_TITLE: Record<HistoryJob['kind'], (j: HistoryJob) => string> = {
  backfill: (j) => `Archiving the local window to ${j.destination ?? 'the active destination'}`,
  copy: (j) =>
    `Copying history from ${j.source ?? 'a removed destination'} to ${j.destination ?? 'a removed destination'}`,
  delete: (j) => `Deleting ${j.destination ?? 'a destination'}'s history`,
}

const STATE_LABEL: Record<HistoryJob['state'], string> = {
  running: 'running',
  blocked: 'cleanup blocked',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** Background jobs: progress, and Cancel / Retry where they make sense. */
export function HistoryJobs({ jobs, owner }: { jobs: HistoryJob[]; owner: boolean }) {
  const act = useJobAction()
  // Open jobs, plus the finished ones of the last day.
  const shown = jobs.filter(
    (j) => j.state === 'running' || j.state === 'blocked' || Date.now() - j.updated_at < 24 * 3_600_000,
  )
  if (!shown.length) return null
  const run = async (id: number, action: 'cancel' | 'retry') => {
    try {
      await act.mutateAsync({ id, action })
    } catch (err) {
      toast.error(action === 'cancel' ? 'Could not cancel it' : 'Could not retry it', {
        description: (err as Error).message,
      })
    }
  }
  return (
    <div className="border-t px-4 py-3">
      <Caps>Jobs</Caps>
      <ul aria-label="History jobs" className="mt-2 flex flex-col gap-2.5">
        {shown.map((j) => {
          const pct = j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : j.state === 'done' ? 100 : 0
          const open = j.state === 'running' || j.state === 'blocked'
          return (
            <li key={j.id} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{JOB_TITLE[j.kind](j)}</span>
                <span
                  className={cn(
                    'font-mono text-[11px]',
                    j.state === 'blocked' || j.state === 'failed' ? 'text-status-warn' : 'text-muted-foreground',
                  )}
                >
                  {fmtCount(j.done)} / {fmtCount(j.total)} h · {fmtBytes(j.bytes)} · {STATE_LABEL[j.state]}
                </span>
                {owner && (j.state === 'blocked' || j.state === 'failed') && (
                  <Button variant="outline" size="xs" onClick={() => run(j.id, 'retry')}>
                    <RotateCcwIcon /> Retry
                  </Button>
                )}
                {owner && open && (
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label={`Cancel job ${j.id}`}
                    onClick={() => run(j.id, 'cancel')}
                  >
                    <XIcon /> Cancel
                  </Button>
                )}
              </div>
              <div
                role="progressbar"
                aria-label={JOB_TITLE[j.kind](j)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                className="h-1 bg-secondary"
              >
                <div
                  className={cn(
                    'h-full',
                    j.state === 'blocked' || j.state === 'failed' ? 'bg-status-warn' : 'bg-brand',
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {j.error && open && (
                <span className="text-status-warn text-xs">
                  {j.error}
                  {j.next_retry && j.next_retry > Date.now()
                    ? ` · retrying in ${Math.ceil((j.next_retry - Date.now()) / 60_000)} min`
                    : ''}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const DISMISS = 'quiet.history.backfill.dismissed'

/** After history is turned on: archive the hours still in the local window now. */
export function BackfillOffer({ h, owner }: { h: HistoryStatus; owner: boolean }) {
  const backfill = useBackfill()
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS) === h.instance_id
    } catch {
      return false
    }
  })
  const running = h.jobs.some((j) => j.kind === 'backfill' && (j.state === 'running' || j.state === 'blocked'))
  if (!owner || dismissed || running || h.active == null || h.backfill_hours === 0) return null
  const hours = h.backfill_hours
  return (
    <div className="flex items-start gap-3 border-t bg-brand/5 px-4 py-3">
      <ArchiveIcon className="mt-0.5 size-4 shrink-0 text-brand" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm">
          {fmtCount(hours)} hour{hours === 1 ? '' : 's'} in the local window {hours === 1 ? "isn't" : "aren't"} archived
          yet
        </span>
        <span className="text-muted-foreground text-xs">
          They would be archived as they leave the window anyway. Archiving them now means history has no hole if the
          window is ever shortened.
        </span>
      </div>
      <Button
        size="xs"
        disabled={backfill.isPending}
        onClick={async () => {
          try {
            await backfill.mutateAsync()
            toast.success(`Archiving ${fmtCount(hours)} hours`, { description: 'Progress shows under Jobs.' })
          } catch (err) {
            toast.error('Could not start it', { description: (err as Error).message })
          }
        }}
      >
        Archive now
      </Button>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => {
          try {
            localStorage.setItem(DISMISS, h.instance_id)
          } catch {
            // private mode: hidden for this visit only
          }
          setDismissed(true)
        }}
      >
        Not now
      </Button>
    </div>
  )
}
