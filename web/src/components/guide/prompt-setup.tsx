import { CheckIcon, ChevronRightIcon, CopyIcon, DownloadIcon, InfoIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  blankGoal,
  downloadPrompt,
  type Goal,
  type GoalKind,
  type GoalMatters,
  type GoalOp,
  type GoalUnit,
  goalHint,
  goalLine,
  NEXT_ITEMS,
  PERIODS,
  SAMPLE_RATES,
  type Setup,
  type StackId,
  slug,
} from '@/lib/guide'
import { cn } from '@/lib/utils'
import { Checklist, FieldRow, inputCls, NativeSelect, Panel, StackPicker } from './kit'

type Update = (patch: Partial<Setup> | ((s: Setup) => Partial<Setup>)) => void

/** The "N goals were added" banner with Undo (11.1). */
export function AddedBanner({ setup, update }: { setup: Setup; update: Update }) {
  const a = setup.lastAdd
  if (!a || !setup.goals.some((g) => g.batch === a.batch)) return null
  const total = setup.goals.length
  return (
    <div role="status" className="flex items-center justify-between gap-4 border bg-card px-4 py-3">
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-[13px]">
          <CheckIcon className="size-3.5 text-status-ok" /> {a.count} {a.pack}{' '}
          {a.count === 1 ? 'goal was' : 'goals were'} added
        </span>
        <span className="text-muted-foreground text-xs">
          {a.existing > 0
            ? `Your ${a.existing} existing ${a.existing === 1 ? 'goal is' : 'goals are'} unchanged. `
            : ''}
          Your prompt now includes {total === 1 ? 'this goal' : `all ${total} goals`}.
        </span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => update((s) => ({ goals: s.goals.filter((g) => g.batch !== a.batch), lastAdd: undefined }))}
      >
        Undo
      </Button>
    </div>
  )
}

const MATTERS: { value: GoalMatters; label: string }[] = [
  { value: 'speed_success', label: 'Speed and success' },
  { value: 'success', label: 'Success only' },
  { value: 'speed', label: 'Speed only' },
]

/** One goal, editing (11.3 behind the drawer). */
function GoalForm({
  g,
  onChange,
  onRemove,
  onDone,
}: {
  g: Goal
  onChange: (g: Goal) => void
  onRemove: () => void
  onDone: () => void
}) {
  const [more, setMore] = useState(false)
  const set = (patch: Partial<Goal>) => onChange({ ...g, ...patch })
  const id = `goal-${g.id}`
  return (
    <fieldset className="flex flex-col gap-3 border bg-background p-3.5" aria-label={`Edit ${g.name || 'new goal'}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px]">{g.name || 'New goal'}</span>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onRemove}>
            Remove
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
      <FieldRow label="Goal name" htmlFor={`${id}-name`}>
        <input
          id={`${id}-name`}
          className={inputCls}
          value={g.name}
          placeholder="Orders finish quickly"
          onChange={(e) => set({ name: e.target.value, key: g.template ? g.key : slug(e.target.value) })}
        />
      </FieldRow>
      <FieldRow label="Applies to" htmlFor={`${id}-applies`}>
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-2">
            <NativeSelect
              label="Kind"
              className="w-32 shrink-0"
              value={g.kind}
              onChange={(v) => set({ kind: v as GoalKind })}
              options={[
                { value: 'request', label: 'Requests' },
                { value: 'job', label: 'Jobs' },
              ]}
            />
            <input
              id={`${id}-applies`}
              className={inputCls}
              value={g.appliesTo}
              placeholder={g.kind === 'job' ? 'Orders queue' : 'Order requests'}
              onChange={(e) => set({ appliesTo: e.target.value })}
            />
          </div>
          <input
            aria-label="Where it runs"
            className={cn(inputCls, 'h-7 border-dashed text-muted-foreground text-xs')}
            value={g.scope}
            placeholder="service · route or queue (your agent maps it if left empty)"
            onChange={(e) => set({ scope: e.target.value })}
          />
        </div>
      </FieldRow>
      <FieldRow label="What matters">
        <NativeSelect
          label="What matters"
          value={g.matters}
          onChange={(v) => set({ matters: v as GoalMatters })}
          options={MATTERS}
        />
      </FieldRow>
      <FieldRow label="Finish in">
        <div className="flex gap-2">
          <NativeSelect
            label="Under or within"
            className="w-28"
            value={g.op}
            onChange={(v) => set({ op: v as GoalOp })}
            options={[
              { value: 'under', label: 'Under' },
              { value: 'within', label: 'Within' },
            ]}
          />
          <input
            aria-label="Time limit"
            type="number"
            min={1}
            className={cn(inputCls, 'w-24')}
            value={g.limit}
            onChange={(e) => set({ limit: Math.max(1, Number(e.target.value) || 1) })}
          />
          <NativeSelect
            label="Unit"
            className="w-36"
            value={g.unit}
            onChange={(v) => set({ unit: v as GoalUnit })}
            options={[
              { value: 'ms', label: 'milliseconds' },
              { value: 'seconds', label: 'seconds' },
              { value: 'minutes', label: 'minutes' },
            ]}
          />
        </div>
      </FieldRow>
      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1.5 text-muted-foreground text-xs">
          Meet this goal for
          <span className={cn(inputCls, 'flex items-center gap-1 text-foreground')}>
            <input
              aria-label="Target percent"
              type="number"
              step={0.1}
              min={1}
              max={100}
              className="w-12 bg-transparent outline-none"
              value={g.target}
              onChange={(e) => set({ target: Math.min(100, Math.max(1, Number(e.target.value) || 99)) })}
            />
            <span className="text-muted-foreground">% of {g.kind === 'job' ? 'jobs' : 'requests'}</span>
          </span>
        </label>
        <div className="flex flex-col gap-1.5 text-muted-foreground text-xs">
          Measured over
          <NativeSelect
            label="Measured over"
            value={String(g.period)}
            onChange={(v) => set({ period: Number(v) })}
            options={PERIODS.map((d) => ({ value: String(d), label: `Last ${d} days` }))}
          />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">{goalHint(g)}</p>
      <button
        type="button"
        aria-expanded={more}
        onClick={() => setMore(!more)}
        className="flex items-center gap-1 self-start text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ChevronRightIcon className={cn('size-3 transition-transform', more && 'rotate-90')} /> More options
        <span className="text-muted-foreground"> · timing, success rules and exclusions</span>
      </button>
      {more && (
        <div className="flex flex-col gap-2">
          {(
            [
              ['timing', 'Timing', 'request start to local response-body completion'],
              ['rules', 'Success rules', 'Correct business rejections count as good'],
              ['exclusions', 'Exclusions', 'test traffic only'],
            ] as const
          ).map(([k, l, ph]) => (
            <FieldRow key={k} label={l} htmlFor={`${id}-${k}`}>
              <input
                id={`${id}-${k}`}
                className={inputCls}
                value={g[k]}
                placeholder={ph}
                onChange={(e) => set({ [k]: e.target.value })}
              />
            </FieldRow>
          ))}
        </div>
      )}
    </fieldset>
  )
}

function GoalCard({ g, onEdit, onRemove }: { g: Goal; onEdit: () => void; onRemove: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 border bg-background px-3.5 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[13px]">
          {g.name || 'Unnamed goal'}
          {g.batch && <span className="text-brand"> · Added</span>}
        </span>
        <span className="truncate text-muted-foreground text-xs">{goalLine(g)}</span>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onEdit} aria-label={`Edit ${g.name}`}>
          Edit
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onRemove} aria-label={`Remove ${g.name}`}>
          Remove
        </Button>
      </div>
    </div>
  )
}

function Section({
  title,
  meta,
  sub,
  children,
}: {
  title: string
  meta?: string
  sub?: string
  children: React.ReactNode
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-3 border-b py-4 last:border-b-0">
      <div className="flex flex-col gap-1">
        <h3 className="text-[13px]">
          {title}
          {meta && <span className="text-muted-foreground"> · {meta}</span>}
        </h3>
        {sub && <p className="text-muted-foreground text-xs">{sub}</p>}
      </div>
      {children}
    </section>
  )
}

const readonlyCls = cn(inputCls, 'flex items-center font-mono text-xs')

/** Set up your logging prompt (v0.1.1-11.1). */
export function PromptSetup({
  setup,
  update,
  stack,
  setStack,
  editing,
  setEditing,
  onReview,
  onTemplates,
}: {
  setup: Setup
  update: Update
  stack: StackId
  setStack: (s: StackId) => void
  editing: string | null
  setEditing: (id: string | null) => void
  onReview: () => void
  onTemplates: () => void
}) {
  const setGoal = (g: Goal) => update((s) => ({ goals: s.goals.map((x) => (x.id === g.id ? g : x)) }))
  const removeGoal = (id: string) => {
    update((s) => ({ goals: s.goals.filter((x) => x.id !== id) }))
    if (editing === id) setEditing(null)
  }
  const [svc, env] = setup.app.split('/').map((x) => x.trim())
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[minmax(0,1fr)_392px] items-start gap-6">
        <Panel
          title="Your setup"
          sub={[svc || 'app not set', env].filter(Boolean).join(' · ')}
          actions={
            <>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Download prompt"
                onClick={() => downloadPrompt(stack)}
              >
                <DownloadIcon />
              </Button>
              <Button type="button" size="sm" onClick={onReview}>
                <CopyIcon /> Review
              </Button>
            </>
          }
        >
          <p className="flex items-center gap-1.5 border-b px-3.5 py-2 font-mono text-[11px] text-muted-foreground">
            <InfoIcon className="size-3" aria-hidden /> Add the goals you need, or leave them for later. Nothing is
            applied until you choose it.
          </p>
          <div className="flex flex-col px-3.5">
            <Section title="App details">
              <FieldRow label="App / environment" htmlFor="setup-app">
                <input
                  id="setup-app"
                  className={cn(inputCls, 'font-mono text-xs')}
                  value={setup.app}
                  placeholder="my-api / production"
                  onChange={(e) => update({ app: e.target.value })}
                />
              </FieldRow>
              <p className="text-muted-foreground text-xs">
                Your coding agent will check the framework version and job queue in your codebase.
              </p>
            </Section>

            <Section
              title="Your goals"
              meta={`${setup.goals.length} added`}
              sub="Choose what good service means for your app. These goals are called SLOs."
            >
              {setup.goals.map((g) =>
                editing === g.id ? (
                  <GoalForm
                    key={g.id}
                    g={g}
                    onChange={setGoal}
                    onRemove={() => removeGoal(g.id)}
                    onDone={() => setEditing(null)}
                  />
                ) : (
                  <GoalCard key={g.id} g={g} onEdit={() => setEditing(g.id)} onRemove={() => removeGoal(g.id)} />
                ),
              )}
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    const g = blankGoal()
                    update((s) => ({ goals: [...s.goals, g] }))
                    setEditing(g.id)
                  }}
                >
                  <PlusIcon /> Add goal
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={onTemplates}>
                  Browse templates
                </Button>
              </div>
            </Section>

            <Section title="What to keep">
              <FieldRow label="Routine logs">
                <NativeSelect
                  label="Routine logs"
                  className="font-mono text-xs"
                  value={String(setup.sample)}
                  onChange={(v) => update({ sample: Number(v) })}
                  options={SAMPLE_RATES.map((r) => ({
                    value: String(r),
                    label: r === 100 ? 'Keep 100% · default' : `Keep ${r}% · changed from the 100% default`,
                  }))}
                />
              </FieldRow>
              <FieldRow label="Other rules" htmlFor="setup-rules">
                <input
                  id="setup-rules"
                  className={cn(inputCls, 'font-mono text-xs')}
                  value={setup.otherRules}
                  placeholder="None added"
                  onChange={(e) => update({ otherRules: e.target.value })}
                />
              </FieldRow>
              <FieldRow label="Request details">
                <NativeSelect
                  label="Request details"
                  value={setup.headers}
                  onChange={(v) => update({ headers: v as Setup['headers'] })}
                  options={[
                    { value: 'approved', label: 'Selected headers · request and response bodies off' },
                    { value: 'none', label: 'No headers · request and response bodies off' },
                  ]}
                />
              </FieldRow>
              <FieldRow label="Size limits">
                <span className={readonlyCls}>8 KB per body · 32 KB per log</span>
              </FieldRow>
              <p className="text-muted-foreground text-xs">
                Errors and missed goals are always kept. This percentage only reduces routine logs.
              </p>
            </Section>

            <Section title="Private information">
              <FieldRow label="Always hide">
                <span className={readonlyCls}>Passwords, access tokens and cookies</span>
              </FieldRow>
              <FieldRow label="Also hide" htmlFor="setup-hide">
                <input
                  id="setup-hide"
                  className={cn(inputCls, 'font-mono text-xs')}
                  value={setup.alsoHide}
                  placeholder="payment.card_number · customer.pin"
                  onChange={(e) => update({ alsoHide: e.target.value })}
                />
              </FieldRow>
              <FieldRow label="Leave visible">
                <span className={readonlyCls}>Email addresses and phone numbers</span>
              </FieldRow>
            </Section>
          </div>
        </Panel>
        <aside className="flex flex-col gap-4">
          <StackPicker
            stack={stack}
            setStack={setStack}
            title="Your app"
            aside="choose your language"
            note="We'll match the instructions to your app's language and framework."
          />
          <Checklist title="What happens next" aside="3 steps · 2 rules" items={NEXT_ITEMS} />
        </aside>
      </div>
    </div>
  )
}
