import { Link } from '@tanstack/react-router'
import { ArrowRightIcon, ChevronRightIcon, DownloadIcon, GaugeIcon, InfoIcon, RowsIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AGENT_ITEMS,
  downloadPrompt,
  goalLine,
  promptFor,
  promptSections,
  type Setup,
  type StackId,
  stackById,
} from '@/lib/guide'
import { cn } from '@/lib/utils'
import { Checklist, CopyPromptButton, Panel } from './kit'

/** The sentence under "Review your logging prompt". */
export function reviewSub(setup: Setup): string {
  const n = setup.goals.length
  const a = setup.lastAdd
  const added = a ? setup.goals.filter((g) => g.batch === a.batch).length : 0
  const head =
    n === 0
      ? 'No goals yet: the prompt keeps every routine log and sets no SLO targets.'
      : added > 0 && a
        ? `Your ${a.existing} existing ${a.existing === 1 ? 'goal' : 'goals'} and ${added} ${a.pack} ${added === 1 ? 'goal are' : 'goals are'} included.`
        : `Your ${n} ${n === 1 ? 'goal is' : 'goals are'} included.`
  return `${head} Copy the prompt when you're ready.`
}

/** Review your logging prompt (v0.1.1-11.2). */
export function PromptReview({
  setup,
  stack,
  onEditGoals,
  onVerify,
}: {
  setup: Setup
  stack: StackId
  onEditGoals: () => void
  onVerify: () => void
}) {
  const text = promptFor(stack, setup)
  const lines = text.split('\n')
  const sections = promptSections(text)
  const reviewedEnd = sections.find((x) => x.title !== 'Reviewed inputs')?.line ?? 0
  const notesAt = sections.find((x) => x.title.startsWith('Stack notes'))?.line ?? 0
  const doneAt = sections.find((x) => x.title === 'Done when')?.line ?? 0
  const s = stackById(stack)
  const n = setup.goals.length
  const nav = sections.filter((x) => x.title !== 'Reviewed inputs')
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_392px] items-start gap-6">
      <Panel
        label="Prompt"
        title="Generated prompt · ready to review"
        sub={`${s.label} · ${n} ${n === 1 ? 'goal' : 'goals'} included`}
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
            <CopyPromptButton stack={stack} size="sm" keys={false} label="Copy" onVerify={onVerify} />
          </>
        }
      >
        <p className="flex items-center gap-1.5 border-b px-3.5 py-2 font-mono text-[11px] text-muted-foreground">
          <InfoIcon className="size-3" aria-hidden /> Copy includes your inputs, event example, shared rules and
          selected language notes.
        </p>
        <pre
          className="overflow-x-auto whitespace-pre-wrap break-words px-3.5 py-3.5 font-mono text-[12px] leading-[19px]"
          data-testid="prompt-text"
        >
          {lines.map((l, i) => {
            const line = i + 1
            const inNotes = notesAt > 0 && line >= notesAt && line < doneAt
            const inInputs = line < reviewedEnd && line > 1
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
                key={i}
                id={`prompt-l${line}`}
                className={cn(
                  'block min-h-[19px]',
                  l.startsWith('## ') && 'font-semibold text-syntax-key',
                  inInputs && !l.startsWith('## ') && 'text-foreground',
                  /^```/.test(l) && 'text-muted-foreground',
                  inNotes && '-mx-3.5 border-brand border-l-2 bg-row-selected px-[12px]',
                )}
              >
                {l}
              </span>
            )
          })}
        </pre>
      </Panel>
      <aside className="flex flex-col gap-4">
        <Panel title="Your goals" aside={`${n} included`}>
          <ul className="flex flex-col">
            {setup.goals.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 border-b px-3.5 py-3">
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-[13px]">{g.name || 'Unnamed goal'}</span>
                  <span className="truncate text-muted-foreground text-xs">
                    {goalLine(g).split(' · ').slice(1).join(' · ')}
                  </span>
                </span>
                <Button type="button" size="sm" variant="outline" onClick={onEditGoals}>
                  Edit
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-3 p-3.5">
            <p className="text-muted-foreground text-xs leading-relaxed">
              {n
                ? 'Your existing goals and selected product goals are included. Edit any goal before copying.'
                : 'No goals yet. Add one, or start from a product template.'}
            </p>
            <Button type="button" variant="outline" className="w-full" onClick={onEditGoals}>
              Back to my goals
            </Button>
          </div>
        </Panel>
        <Checklist title="What your agent will do" aside="from your setup" items={AGENT_ITEMS} />
        <VerifyInQuiet />
        <Panel title="In this prompt" aside="sections">
          <ul>
            {nav.map((x, i) => (
              <li key={x.line} className="border-b last:border-b-0">
                <a
                  href={`#prompt-l${x.line}`}
                  className={cn(
                    'flex h-[30px] items-center gap-3 px-3.5 text-[13px] hover:bg-accent',
                    x.title.startsWith('Stack notes') && 'bg-row-selected text-brand',
                  )}
                >
                  <span className="w-5 font-mono text-[11px] text-muted-foreground">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="flex-1">{x.title === 'Sampling' && n ? 'Sampling · your SLOs' : x.title}</span>
                  <ChevronRightIcon className="size-3.5 text-muted-foreground" />
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      </aside>
    </div>
  )
}

/** Verify in quiet · test fixture (11.2). */
function VerifyInQuiet() {
  const step = (n: number, title: string, body: React.ReactNode, last = false) => (
    <li className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-3">
      <span className="flex size-[22px] items-center justify-center border font-mono text-[11px]">{n}</span>
      <span className="pt-0.5 font-medium text-[13px]">{title}</span>
      <span className={cn('mx-auto w-px', !last && 'bg-border')} />
      <div className="flex flex-col gap-2 pt-2 pb-4">{body}</div>
    </li>
  )
  return (
    <Panel
      title="Verify in quiet"
      actions={<span className="border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">test fixture</span>}
    >
      <ol className="flex flex-col px-3.5 pt-3.5">
        {step(
          1,
          'Keep the test event',
          <>
            <code className="block border bg-code px-2.5 py-2 font-mono text-[11px] leading-relaxed">
              $ curl -i -X POST $API/api/v1/orders
              <br />
              <span className="text-muted-foreground">HTTP/1.1 201 Created</span>
              <br />
              <span className="text-muted-foreground">x-request-id: req_8f2a8c</span>
            </code>
            <span className="font-mono text-[11px] text-muted-foreground">
              Use 100% sampling or force retention in a test environment.
            </span>
          </>,
        )}
        {step(
          2,
          'See exactly one canonical line',
          <>
            <span className="flex items-center gap-2 border border-l-2 border-l-brand bg-background px-2 py-1 font-mono text-[11px]">
              <span className="text-muted-foreground">14:07</span>
              <span className="bg-level-info-muted px-1 text-level-info">info</span>
              <span className="flex-1 truncate">POST /api/v1/orders</span>
              <span className="text-status-ok">201 · 142ms</span>
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              One retained completion per request execution.
            </span>
          </>,
        )}
        {step(
          3,
          'Open it as a flow (↵)',
          <>
            <span className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
              <span className="flex items-center gap-1.5 border px-2 py-1">
                <span className="size-1.5 rounded-full bg-status-ok" /> create_order
              </span>
              <ArrowRightIcon className="size-3 text-brand" />
              <span className="flex items-center gap-1.5 border px-2 py-1">
                <span className="size-1.5 rounded-full bg-status-ok" /> ord-delivery-1182
              </span>
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              Shared request_id relates records; queue links prove parentage.
            </span>
          </>,
          true,
        )}
      </ol>
      <div className="flex gap-2 px-3.5 pb-3.5">
        <Link to="/">
          <Button type="button" size="sm" variant="outline">
            <RowsIcon /> Open stream
          </Button>
        </Link>
        <Link to="/guide" search={{ tab: 'check' }}>
          <Button type="button" size="sm" variant="outline">
            <GaugeIcon /> Check my logs
          </Button>
        </Link>
      </div>
    </Panel>
  )
}
