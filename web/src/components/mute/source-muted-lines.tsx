import { Link } from '@tanstack/react-router'
import { CheckIcon, ExternalLinkIcon, GlobeIcon, LockIcon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react'
import { useState } from 'react'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { MuteRule, SourceSettings } from '@/gen'
import { globalOff, routePath, ruleText } from '@/lib/mute'
import {
  restoreOf,
  ruleHits,
  sumHits,
  useAddMuteRule,
  useDeleteMuteRule,
  useMuteStats,
  useSetGlobalApply,
  useUpdateMuteRule,
} from '@/lib/mute-api'
import { DEFAULT_SOURCE_SETTINGS, useSaveSource, useSettings } from '@/lib/settings-api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { AddRuleDialog } from './add-rule-dialog'
import {
  DELETE_CONFIRM_AT,
  fmtN,
  fmtWhen,
  GlobalTag,
  Meta,
  OWNERS_ONLY,
  Pattern,
  Segmented,
  ShapeChip,
  WhoWhen,
} from './rule-bits'

/**
 * Sources → edit → Muted lines (06.13–06.25): this source's rules and the
 * global ones, each global rule with its "apply here" switch, and the
 * per-source Include muted lines in search. Every change applies right away
 * (Undo in the toast). Members see the same, read-only (06.23).
 */
export function SourceMutedLines({ name, owner }: { name: string; owner: boolean }) {
  const data = useSettings().data
  const stats = useMuteStats().data
  const own: SourceSettings = data?.sources[name] ?? DEFAULT_SOURCE_SETTINGS
  const global = data?.muted_global ?? []
  const [adding, setAdding] = useState(false)
  const applying = global.filter((g) => g.enabled && !globalOff(own, g.id))
  const hitsHere = (r: MuteRule) => ruleHits(stats, r.id)[name] ?? 0
  const ownHidden = own.muted.filter((r) => r.enabled).reduce((n, r) => n + hitsHere(r), 0)
  const globalHidden = applying.reduce((n, r) => n + hitsHere(r), 0)
  const est = stats?.sources[name]?.estimated ? '~' : ''

  return (
    <div className="flex flex-col gap-4" data-testid="source-muted-lines">
      <div className="flex items-center gap-2">
        <span className="font-medium">Muted lines</span>
        <span className="border px-1.5 py-px font-mono text-[11px] text-muted-foreground">{name}</span>
        <span className="flex-1" />
        {owner ? (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <PlusIcon /> Add rule
          </Button>
        ) : (
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <LockIcon className="size-3" /> read-only
          </span>
        )}
      </div>
      <p className="-mt-2 text-muted-foreground text-xs">
        Hidden from stream and search. Still stored; Show muted brings them back.
      </p>
      <div className="flex items-center gap-2 border border-dashed px-3 py-2 text-xs">
        <GlobeIcon className="size-3.5 text-brand" aria-hidden />
        <span>Global rules also apply</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          · {global.length} {global.length === 1 ? 'rule' : 'rules'}, {applying.length} apply here
        </span>
        <span className="flex-1" />
        <Link to="/settings/muted-lines" className="inline-flex items-center gap-1 hover:underline">
          Settings <ExternalLinkIcon className="size-3" />
        </Link>
      </div>

      <section aria-label="This source" className="flex flex-col">
        <div className="flex items-center justify-between pb-1 font-mono text-[11px] text-muted-foreground">
          <span className="uppercase tracking-[0.06em]">This source</span>
          <span>
            {own.muted.length} {own.muted.length === 1 ? 'rule' : 'rules'} · {est}
            {fmtN(ownHidden)} hidden · 24h
          </span>
        </div>
        {own.muted.length === 0 ? (
          <div className="flex flex-col items-start gap-2 border border-dashed px-4 py-4">
            <span className="text-sm">No rules for {name} yet</span>
            <span className="text-muted-foreground text-xs">
              {applying.length > 0
                ? `${applying.length} global ${applying.length === 1 ? 'rule hides' : 'rules hide'} lines here already. `
                : ''}
              Add one here, or hover a line in the stream and press M.
            </span>
            {owner && (
              <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                <PlusIcon /> Add rule
              </Button>
            )}
          </div>
        ) : (
          <ul className="flex flex-col divide-y border-y">
            {own.muted.map((r) => (
              <SourceRuleRow key={r.id} rule={r} source={name} owner={owner} hits={hitsHere(r)} />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Global from Settings" className="flex flex-col">
        <div className="flex items-center justify-between pb-1 font-mono text-[11px] text-muted-foreground">
          <span className="uppercase tracking-[0.06em]">Global · from Settings</span>
          <span>
            {global.length} {global.length === 1 ? 'rule' : 'rules'} · {est}
            {fmtN(globalHidden)} hidden here
          </span>
        </div>
        {global.length === 0 ? (
          <p className="border border-dashed px-4 py-3 text-muted-foreground text-xs">
            No global rules. Add one in Settings → Muted lines, or pick All sources when you add a rule.
          </p>
        ) : (
          <ul className="flex flex-col divide-y border-y">
            {global.map((g) => (
              <GlobalRuleRow
                key={g.id}
                rule={g}
                source={name}
                settings={own}
                owner={owner}
                hitsHere={hitsHere(g)}
                hitsAll={ruleHits(stats, g.id)}
              />
            ))}
          </ul>
        )}
      </section>

      <p className="text-muted-foreground text-xs">
        A line is hidden when any rule matches: this source's rules plus the global rules switched on here. Turn a
        global rule off to keep its lines on {name} only.
      </p>
      <IncludeInSearch name={name} owner={owner} />

      <AddRuleDialog open={adding} onOpenChange={setAdding} source={name} scope="source" canGlobal={owner} />
    </div>
  )
}

function SourceRuleRow({
  rule,
  source,
  owner,
  hits,
}: {
  rule: MuteRule
  source: string
  owner: boolean
  hits: number
}) {
  const update = useUpdateMuteRule()
  const del = useDeleteMuteRule()
  const add = useAddMuteRule()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(rule.value)
  const [confirm, setConfirm] = useState(false)

  const toggle = (on: boolean) =>
    update.mutate(
      { id: rule.id, patch: { enabled: on } },
      {
        onSuccess: () =>
          toast.success(on ? `Rule on · ${ruleText(rule)}` : `Rule paused · ${ruleText(rule)}`, {
            description: on ? `Hides its lines on ${source} again.` : 'Kept with its history; hides nothing until on.',
            button: { title: 'Undo', onClick: () => update.mutate({ id: rule.id, patch: { enabled: !on } }) },
          }),
        onError: (e) => toast.error('Could not change the rule', { description: e.message }),
      },
    )
  const remove = async () => {
    try {
      const d = await del.mutateAsync(rule.id)
      setConfirm(false)
      toast.success(`Deleted rule ${ruleText(rule)}`, {
        description: `${fmtN(hits)} lines on ${source} show again.`,
        duration: 8000,
        button: { title: 'Undo', onClick: () => add.mutate(restoreOf(d)) },
      })
    } catch (e) {
      toast.error('Could not delete the rule', { description: (e as Error).message })
    }
  }
  const save = async () => {
    const v = rule.shape === 'route' || rule.shape === 'method_route' ? routePath(value) : value.trim()
    if (!v) return
    try {
      await update.mutateAsync({ id: rule.id, patch: { value: v } })
      setEditing(false)
    } catch (e) {
      toast.error('Could not save the rule', { description: (e as Error).message })
    }
  }

  return (
    <li className={cn('flex items-start gap-3 py-2.5', !rule.enabled && 'opacity-80')} data-rule={rule.id}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <ShapeChip shape={rule.shape} />
          {editing ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                save()
              }}
            >
              {rule.shape === 'method_route' && <span className="font-mono text-[13px] text-brand">{rule.method}</span>}
              <Input
                autoFocus
                aria-label="Rule value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return
                  e.stopPropagation()
                  setEditing(false)
                }}
                className="h-7 font-mono text-[13px]"
              />
              <Button type="submit" size="icon-sm" variant="outline" aria-label="Save rule">
                <CheckIcon />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Cancel edit"
                onClick={() => setEditing(false)}
              >
                <XIcon />
              </Button>
            </form>
          ) : owner ? (
            <button
              type="button"
              className="min-w-0 text-left hover:underline hover:decoration-dotted"
              title="Edit rule"
              onClick={() => {
                setValue(rule.value)
                setEditing(true)
              }}
            >
              <Pattern rule={rule} />
            </button>
          ) : (
            <Pattern rule={rule} />
          )}
        </div>
        {editing && value.trim().endsWith('*') && (
          <span className="font-mono text-[11px] text-status-warn">
            * also catches {routePath(value).replace(/\*$/, '')}z and anything else that starts the same way
          </span>
        )}
        <Meta>
          {rule.enabled ? (
            <span className="text-foreground/90">{fmtN(hits)} hidden</span>
          ) : (
            <Tooltip>
              <TooltipTrigger render={<span className="cursor-help text-status-warn">paused</span>} />
              <TooltipContent>Paused rules keep their history and hide nothing until switched on.</TooltipContent>
            </Tooltip>
          )}
          {rule.enabled ? <span>24h</span> : <span className="text-status-warn">would hide {fmtN(hits)}</span>}
          <WhoWhen rule={rule} />
        </Meta>
      </div>
      <Switch
        aria-label={`${rule.enabled ? 'Pause' : 'Resume'} ${ruleText(rule)}`}
        checked={rule.enabled}
        disabled={!owner || update.isPending}
        onCheckedChange={(v) => toggle(Boolean(v))}
      />
      {owner && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${ruleText(rule)}`}
          onClick={() => (hits >= DELETE_CONFIRM_AT ? setConfirm(true) : remove())}
        >
          <Trash2Icon />
        </Button>
      )}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this rule?</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{ruleText(rule)}</span> hides {fmtN(hits)} lines a day on {source}. They show
              again in the stream and search. You can Undo from the toast.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={remove} disabled={del.isPending}>
              <Trash2Icon /> Delete rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  )
}

function GlobalRuleRow({
  rule,
  source,
  settings,
  owner,
  hitsHere,
  hitsAll,
}: {
  rule: MuteRule
  source: string
  settings: SourceSettings
  owner: boolean
  hitsHere: number
  hitsAll: Record<string, number>
}) {
  const off = globalOff(settings, rule.id)
  const apply = useSetGlobalApply()
  const [ask, setAsk] = useState(false)
  const set = (on: boolean) =>
    apply.mutate(
      { source, id: rule.id, apply: on },
      {
        onSuccess: () => {
          setAsk(false)
          toast.success(on ? `Global rule on again for ${source}` : `Global rule off for ${source}`, {
            description: `${ruleText(rule)} · ${on ? 'hides' : 'stops hiding'} ${fmtN(hitsHere)} lines here`,
            button: { title: 'Undo', onClick: () => apply.mutate({ source, id: rule.id, apply: !on }) },
          })
        },
        onError: (e) => toast.error('Could not change the rule here', { description: e.message }),
      },
    )
  const others = Object.keys(hitsAll).filter((s) => s !== source).length
  const allHits = sumHits(hitsAll)

  return (
    <li className="flex items-start gap-3 py-2.5" data-rule={rule.id}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <GlobalTag />
          <ShapeChip shape={rule.shape} />
          <Pattern rule={rule} />
        </div>
        <Meta>
          {!rule.enabled ? (
            <span className="text-status-warn">paused everywhere · would hide {fmtN(hitsHere)} here</span>
          ) : off ? (
            <>
              <span className="text-status-warn">Don't apply here</span>
              {off.by && <span>{off.by}</span>}
              {off.at ? <span>{fmtWhen(off.at)}</span> : null}
              <span>would hide {fmtN(hitsHere)} here</span>
            </>
          ) : (
            <>
              <span className="text-foreground/90">{fmtN(hitsHere)} hidden here</span>
              <span>24h</span>
              <span>
                {fmtN(allHits)} on {Object.keys(hitsAll).length} sources
              </span>
              {rule.created_by && <span>{rule.created_by}</span>}
              {rule.created_at ? <span>{fmtWhen(rule.created_at)}</span> : null}
            </>
          )}
        </Meta>
      </div>
      <span className={cn('pt-0.5 font-mono text-[11px]', off ? 'text-status-warn' : 'text-muted-foreground')}>
        {off ? 'off here' : 'apply here'}
      </span>
      {owner ? (
        <Popover open={ask} onOpenChange={setAsk}>
          <PopoverTrigger
            render={
              <Switch
                aria-label={`Apply ${ruleText(rule)} on ${source}`}
                checked={!off}
                disabled={apply.isPending}
                onCheckedChange={(v) => (v ? set(true) : setAsk(true))}
              />
            }
            nativeButton={false}
          />
          <PopoverContent align="end" className="w-80">
            <span className="font-medium text-sm">Don't apply here?</span>
            <span className="text-muted-foreground text-xs">
              <span className="font-mono">{ruleText(rule)}</span> stops hiding lines on {source} ({fmtN(hitsHere)} in
              24h). It stays on{' '}
              {others > 0 ? `${others} other ${others === 1 ? 'source' : 'sources'}` : 'every other source'} and on new
              sources.
            </span>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAsk(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => set(false)} disabled={apply.isPending}>
                Don't apply here
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Switch aria-label={`Apply ${ruleText(rule)} on ${source}`} checked={!off} disabled />
          </TooltipTrigger>
          <TooltipContent>{OWNERS_ONLY}</TooltipContent>
        </Tooltip>
      )}
    </li>
  )
}

/** Per-source Include muted lines in search: Inherit / On / Off (inherit → Settings → Muted lines). */
function IncludeInSearch({ name, owner }: { name: string; owner: boolean }) {
  const data = useSettings().data
  const saved = data?.sources[name] ?? DEFAULT_SOURCE_SETTINGS
  const instance = data?.muted_search.include ?? false
  const save = useSaveSource(name)
  const value = saved.search_include_muted == null ? 'inherit' : saved.search_include_muted ? 'on' : 'off'
  const change = (v: 'inherit' | 'on' | 'off') =>
    save.mutate(
      { ...saved, search_include_muted: v === 'on' ? true : v === 'off' ? false : null },
      { onError: (e) => toast.error('Could not save', { description: e.message }) },
    )
  return (
    <div className="flex items-center justify-between gap-4 border-t pt-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm">Include muted lines in search</span>
        <span className="text-muted-foreground text-xs">
          Inherit follows Settings → Muted lines ({instance ? 'on' : 'off'} now; off by default).
        </span>
      </div>
      <div className="w-56">
        <Segmented
          label="Include muted lines in search"
          size="sm"
          value={value}
          onChange={(v) => owner && change(v)}
          options={[
            {
              value: 'inherit',
              label: `Inherit (${instance ? 'on' : 'off'})`,
              disabled: !owner && value !== 'inherit',
            },
            { value: 'on', label: 'On', disabled: !owner && value !== 'on' },
            { value: 'off', label: 'Off', disabled: !owner && value !== 'off' },
          ]}
        />
      </div>
    </div>
  )
}
