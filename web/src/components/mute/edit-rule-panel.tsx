import { CornerDownLeftIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { MuteRule, MuteShape } from '@/gen'
import { routePath, ruleText, sameRule } from '@/lib/mute'
import { useMutePreview, useUpdateMuteRule } from '@/lib/mute-api'
import { toast } from '@/lib/toast'
import { useDebounced } from '@/lib/use-debounced'
import { type Draft, fromRule, METHODS, SHAPES, toRule } from './add-rule-dialog'
import { fmtN, Meta, Segmented, WhoWhen } from './rule-bits'

/**
 * Edit a source rule in place (06.18): the row opens into a panel with the
 * shape tabs, the value, and the live change in what it hides
 * (`312 → 318 hidden · 24h +6`). Save ↵, Esc cancels.
 */
export function EditRulePanel({
  rule,
  source,
  hits,
  onDone,
}: {
  rule: MuteRule
  source: string
  /** What the saved rule hides here now (24h). */
  hits: number
  onDone: () => void
}) {
  const [d, setD] = useState<Draft>(() => fromRule(rule))
  const update = useUpdateMuteRule()
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }))
  const keepField = rule.shape === 'route' || rule.shape === 'method_route' ? rule.field : null
  const draft = toRule(d, 'source', keepField)
  const changed = !sameRule(rule, draft)
  const debounced = useDebounced(draft, 250)
  const preview = useMutePreview([debounced], [source], changed && debounced.value.length > 0)
  const p = changed && draft.value ? preview.data?.[0] : undefined
  const after = p && !p.invalid ? (p.per_source[source] ?? p.total) : hits
  const delta = after - hits
  const valid =
    draft.value.length > 0 &&
    (draft.shape !== 'field' || Boolean(draft.field)) &&
    (draft.shape !== 'route' && draft.shape !== 'method_route' ? true : draft.value.startsWith('/'))
  const wildcard =
    (d.shape === 'route' || d.shape === 'method_route') && d.route.trim().endsWith('*') && !rule.value.endsWith('*')

  const save = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!valid || update.isPending) return
    if (!changed) return onDone()
    try {
      await update.mutateAsync({
        id: rule.id,
        patch: { shape: draft.shape, field: draft.field, value: draft.value, method: draft.method },
      })
      toast.success(`Rule saved · ${ruleText(draft)}`, { description: `On ${source}.` })
      onDone()
    } catch (err) {
      toast.error('Could not save the rule', { description: (err as Error).message })
    }
  }

  return (
    <form
      onSubmit={save}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        onDone()
      }}
      aria-label="Edit rule"
      className="flex flex-col gap-2 bg-row-selected px-2.5 py-3 shadow-[inset_2px_0_0_var(--brand)]"
    >
      <div className="flex items-center justify-between gap-3 pl-0.5">
        <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">Edit rule</span>
        <Meta>
          <WhoWhen rule={rule} />
        </Meta>
      </div>
      <Segmented
        label="Rule shape"
        size="sm"
        pack
        value={d.shape === 'text' ? 'field' : (d.shape as Exclude<MuteShape, 'text'>)}
        onChange={(shape) => set({ shape })}
        options={SHAPES.map((s) => (s.value === 'field' ? { ...s, label: 'Field' } : s))}
      />
      {(d.shape === 'route' || d.shape === 'method_route') && (
        <div className="flex items-center gap-2">
          {d.shape === 'method_route' && (
            <Select value={d.method} onValueChange={(v) => v && set({ method: v })}>
              <SelectTrigger aria-label="Method" className="h-9 w-24 font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHODS.map((m) => (
                  <SelectItem key={m} value={m} className="font-mono">
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="relative flex-1">
            <Input
              autoFocus
              aria-label="Route"
              value={d.route}
              onChange={(e) => set({ route: e.target.value })}
              className="pr-24 font-mono"
            />
            {d.shape === 'route' && (
              <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 font-mono text-[11px] text-muted-foreground">
                any method
              </span>
            )}
          </div>
        </div>
      )}
      {d.shape === 'message' && (
        <div className="relative">
          <Input
            autoFocus
            aria-label="Message"
            value={d.message}
            onChange={(e) => set({ message: e.target.value })}
            className="pr-14 font-mono"
          />
          <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 font-mono text-[11px] text-muted-foreground">
            exact
          </span>
        </div>
      )}
      {d.shape === 'field' && (
        <div className="grid grid-cols-[minmax(0,1fr)_36px_minmax(0,1.5fr)] items-center gap-2">
          <Input
            autoFocus
            aria-label="Field"
            value={d.field}
            onChange={(e) => set({ field: e.target.value })}
            placeholder="user_agent"
            className="font-mono"
          />
          <span className="flex h-9 items-center justify-center border font-mono text-muted-foreground">=</span>
          <Input
            aria-label="Value"
            value={d.value}
            onChange={(e) => set({ value: e.target.value })}
            className="font-mono"
          />
        </div>
      )}
      <p aria-live="polite" className="font-mono text-xs">
        {fmtN(hits)} → {changed && preview.isFetching && !p ? '…' : fmtN(after)} hidden · 24h
        {delta !== 0 && (
          <span className={delta > 0 ? 'text-status-warn' : 'text-status-ok'}>
            {' '}
            {delta > 0 ? '+' : '−'}
            {fmtN(Math.abs(delta))}
          </span>
        )}
      </p>
      {wildcard && (
        <span className="text-muted-foreground text-xs">
          The * also catches {routePath(d.route).replace(/\*$/, '')}z. Drop it to keep the rule exact.
        </span>
      )}
      {p?.invalid && <span className="text-status-err text-xs">{p.invalid}</span>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!valid || update.isPending}>
          Save rule <CornerDownLeftIcon className="opacity-60" />
        </Button>
      </div>
    </form>
  )
}
