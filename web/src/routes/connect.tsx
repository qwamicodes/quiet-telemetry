import { getRouteApi, Link } from '@tanstack/react-router'
import {
  ArrowRightIcon,
  CheckIcon,
  ClockIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  PlusIcon,
  RefreshCwIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { CodeBlock } from '@/components/connect/code-block'
import { CopyButton } from '@/components/copy-button'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type { Health, SourceInfo } from '@/gen'
import { useHealth, useSources } from '@/lib/api'
import { isOwner, useMe } from '@/lib/auth-api'
import {
  asksName,
  bindsSource,
  CONNECT_KINDS,
  type ConnectKind,
  firstArrival,
  KIND_INFO,
  maskIn,
  maskToken,
  snippets,
} from '@/lib/connect'
import { fmtElapsed, fmtTime } from '@/lib/format'
import { toast } from '@/lib/toast'
import { useCreateToken } from '@/lib/tokens-api'
import { cn } from '@/lib/utils'

const route = getRouteApi('/connect')

const ID_ORDER = ['request_id', 'job_id', 'trace_id', 'correlation_id']

function KindOption({ kind, selected }: { kind: ConnectKind; selected: boolean }) {
  const k = KIND_INFO[kind]
  return (
    <Link
      to="/connect"
      search={{ kind }}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex h-15 items-center gap-3 border bg-card px-3 outline-none hover:bg-muted/50 focus-visible:border-ring',
        selected && 'border-brand bg-brand/10',
      )}
    >
      <span className="flex size-8 items-center justify-center border bg-secondary font-mono font-semibold text-[13px]">
        {k.letter}
      </span>
      <span className="flex flex-1 flex-col">
        <span className="font-medium text-[13px]">{k.title}</span>
        <span className="text-muted-foreground text-xs">{k.blurb}</span>
      </span>
      <span
        aria-hidden
        className={cn('size-3.5 rounded-full border', selected && 'border-4 border-brand bg-background')}
      />
    </Link>
  )
}

function StepHead({ n, title, state }: { n: number; title: string; state: 'active' | 'todo' | 'done' }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={cn(
          'flex size-5 items-center justify-center border font-mono text-[11px]',
          state === 'done' && 'border-status-ok text-status-ok',
          state === 'active' && 'border-foreground',
          state === 'todo' && 'text-muted-foreground',
        )}
      >
        {state === 'done' ? <CheckIcon className="size-3" /> : n}
      </span>
      <h3
        className={cn(
          'font-medium text-[13px]',
          state === 'done' && 'text-status-ok',
          state === 'todo' && 'text-muted-foreground',
        )}
      >
        {title}
      </h3>
    </div>
  )
}

/** Shown on every HTTP panel: what stands between a shipper and this server. */
function Reachability({ health }: { health: Health | undefined }) {
  if (!health) return null
  return (
    <div className="flex flex-col gap-1 text-muted-foreground text-xs">
      {health.ingest.loopback && (
        <p>
          quiet listens on loopback only. Shippers on other machines need{' '}
          <code className="font-mono text-foreground">QUIET_ADDR=0.0.0.0:7070</code>; ingest stays gated by tokens and
          the UI by sign-in.
        </p>
      )}
      {health.ingest.auth === 'open' && (
        <p className="text-level-warn">
          Ingest is open (<code className="font-mono">QUIET_INGEST_AUTH=open</code>): lines without a token are accepted
          too.
        </p>
      )}
    </div>
  )
}

function DockerSocket({ health, onCheck }: { health: Health | undefined; onCheck: () => void }) {
  const d = health?.docker
  const [label, tone] =
    d?.state === 'connected'
      ? [`readable · ${d.containers} containers`, 'text-status-ok']
      : d?.state === 'unavailable'
        ? ['not mounted yet', 'text-level-warn']
        : d?.state === 'disabled'
          ? ['off (QUIET_DOCKER=off)', 'text-muted-foreground']
          : ['checking…', 'text-muted-foreground']
  return (
    <div className="flex h-10 items-center gap-2.5 border bg-muted/40 pr-1.5 pl-3">
      <span className="text-muted-foreground text-xs">Docker socket</span>
      <span className="font-mono text-[13px]">/var/run/docker.sock · read-only</span>
      <span className="flex-1" />
      <span className={cn('font-mono text-[11px]', tone)}>{label}</span>
      <Button size="sm" variant="outline" onClick={onCheck}>
        <RefreshCwIcon /> Check again
      </Button>
    </div>
  )
}

function TokenRow({ token, revealed, onReveal }: { token: string; revealed: boolean; onReveal: () => void }) {
  return (
    <div className="flex h-10 items-center gap-2.5 border bg-muted/40 pr-1.5 pl-3" data-testid="token-row">
      <KeyRoundIcon className="size-3.5 text-muted-foreground" />
      <span className="text-muted-foreground text-xs">Ingest token</span>
      <span className="truncate font-mono text-[13px]">{revealed ? token : maskToken(token)}</span>
      <span className="flex-1" />
      <span className="font-mono text-[11px] text-muted-foreground">new</span>
      <Button size="sm" variant="ghost" onClick={onReveal}>
        {revealed ? <EyeOffIcon /> : <EyeIcon />} {revealed ? 'Hide' : 'Reveal'}
      </Button>
      <CopyButton text={token} what="Token" />
    </div>
  )
}

type Waiting = { since: number; baseline: Record<string, number> }

function Wait({
  kind,
  waiting,
  arrived,
  name,
  token,
  origin,
}: {
  kind: ConnectKind
  waiting: Waiting
  arrived: { source: SourceInfo; at: number } | null
  name: string
  token: string | null
  origin: string
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (arrived) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [arrived])
  if (arrived) {
    const s = arrived.source
    return (
      <div className="flex items-center gap-3 border border-status-ok/50 bg-status-ok/5 p-3.5" role="status">
        <CheckIcon className="size-4 text-status-ok" />
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="font-medium text-[13px]">{s.name} is connected</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            first line {fmtTime(s.last_ts ?? arrived.at)} · {s.lines - (waiting.baseline[s.name] ?? 0)} lines so far
          </span>
        </div>
        <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/connect" />}>
          <PlusIcon /> Connect another
        </Button>
        <Button size="sm" nativeButton={false} render={<Link to="/" search={{ source: s.name }} />}>
          Open stream <ArrowRightIcon />
        </Button>
      </div>
    )
  }
  const elapsed = now - waiting.since
  const hint =
    kind === 'docker'
      ? 'no lines yet · is the container writing to stdout?'
      : `no lines yet · can the shipper reach ${origin}? A 401 in its log means the token is wrong.`
  return (
    <div className="flex flex-col gap-3 border bg-code p-3.5 font-mono text-xs" role="status">
      <div className="flex items-center gap-2 text-level-warn">
        <StatusDot status="warn" pulse />
        <span>{kind === 'docker' ? 'watching /var/run/docker.sock …' : 'waiting for the first line …'}</span>
        <span className="flex-1" />
        <span className="text-muted-foreground">{fmtElapsed(elapsed)}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-2 w-[70%]" />
        <Skeleton className="h-2 w-[58%]" />
        <Skeleton className="h-2 w-[64%]" />
      </div>
      {token && (
        <div className="flex items-center gap-2">
          <CheckIcon className="size-3 text-status-ok" /> token {maskToken(token)} ready
          {bindsSource(kind) && ` · sends to ${name}`}
        </div>
      )}
      {elapsed > 20_000 && (
        <div className="flex items-center gap-2 text-level-warn">
          <ClockIcon className="size-3" /> {hint}
        </div>
      )}
      <p className="font-sans text-muted-foreground">
        Tip: health checks usually arrive first. Lines show up here about a second after they are sent.
      </p>
    </div>
  )
}

function Panel({ kind }: { kind: ConnectKind }) {
  const healthQ = useHealth()
  const health = healthQ.data
  const sources = useSources().data
  const create = useCreateToken()
  const owner = isOwner(useMe())
  const info = KIND_INFO[kind]
  const origin = window.location.origin
  const [name, setName] = useState(kind === 'otlp' ? 'my-service' : 'my-app')
  const [token, setToken] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [tab, setTab] = useState(0)
  const [waiting, setWaiting] = useState<Waiting | null>(null)
  const [arrived, setArrived] = useState<{ source: SourceInfo; at: number } | null>(null)

  const startWaiting = () =>
    setWaiting({ since: Date.now(), baseline: Object.fromEntries((sources ?? []).map((s) => [s.name, s.lines])) })

  // Docker needs no token: wait as soon as the panel opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when sources first load
  useEffect(() => {
    if (kind === 'docker' && !waiting && sources) startWaiting()
  }, [kind, sources == null])

  useEffect(() => {
    if (!waiting || arrived || !sources) return
    const s = firstArrival(kind, sources, waiting.baseline, asksName(kind) ? name : undefined)
    if (s) {
      setArrived({ source: s, at: Date.now() })
      toast.success(`${s.name} is connected`, { description: 'Lines are flowing.' })
    }
  }, [sources, waiting, arrived, kind, name])

  const generate = async () => {
    const source = name.trim()
    if (asksName(kind) && !source) return
    try {
      const r = await create.mutateAsync({
        name: asksName(kind) ? `${info.title.toLowerCase()} · ${source}` : info.title.toLowerCase(),
        source: bindsSource(kind) ? source : undefined,
      })
      setToken(r.secret)
      startWaiting()
    } catch (e) {
      toast.error('Could not create a token', { description: (e as Error).message })
    }
  }

  const snips = useMemo(
    () =>
      snippets(kind, {
        origin,
        token: token ?? 'qi_…',
        source: name.trim() || 'my-app',
        version: health?.version ?? '0.1.0',
      }),
    [kind, origin, token, name, health?.version],
  )
  const snip = snips[Math.min(tab, snips.length - 1)]
  const shipped = kind === 'docker' || token != null

  return (
    <section
      aria-label={`Connect ${info.title}`}
      className="flex min-w-0 flex-1 flex-col gap-5 border bg-card p-6 xl:max-w-[724px]"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-xl tracking-tight">{info.title}</h2>
        <span className="font-mono text-[11px] text-muted-foreground">about 2 min</span>
      </div>

      <div className="flex flex-col gap-2.5">
        <StepHead
          n={1}
          title={kind === 'docker' ? 'Give quiet read access to Docker' : 'Ship lines to quiet'}
          state={arrived ? 'done' : 'active'}
        />
        {asksName(kind) && !token && (
          <div className="flex flex-col gap-1.5 text-xs">
            <label htmlFor="connect-name" className="text-muted-foreground">
              {kind === 'otlp' ? 'Service name (becomes the source)' : 'Source name'}
            </label>
            <Input
              id="connect-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="max-w-80 font-mono"
              aria-label={kind === 'otlp' ? 'Service name' : 'Source name'}
            />
          </div>
        )}
        {kind !== 'docker' && !token ? (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-xs">
              {owner
                ? 'quiet makes a send-only ingest token for this shipper and fills it into the config below.'
                : 'Shippers need an ingest token, and only an owner can create one. Ask an owner to connect this source, or to create a token in Settings → Ingest tokens.'}
            </p>
            {owner && (
              <div>
                <Button onClick={generate} disabled={create.isPending || (asksName(kind) && !name.trim())}>
                  <KeyRoundIcon /> {create.isPending ? 'Creating…' : 'Generate token'}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <>
            {snips.length > 1 && (
              <div className="flex gap-1" role="tablist">
                {snips.map((s, i) => (
                  <Button
                    key={s.file}
                    role="tab"
                    aria-selected={i === tab}
                    size="xs"
                    variant={i === tab ? 'secondary' : 'ghost'}
                    onClick={() => setTab(i)}
                  >
                    {s.file}
                  </Button>
                ))}
              </div>
            )}
            <CodeBlock
              file={snip.file}
              shown={revealed || !token ? snip.code : maskIn(snip.code, token)}
              copy={snip.code}
            />
            <p className="text-muted-foreground text-xs">{snip.note}</p>
            {kind === 'docker' ? (
              <DockerSocket health={health} onCheck={() => healthQ.refetch()} />
            ) : (
              token && <TokenRow token={token} revealed={revealed} onReveal={() => setRevealed((r) => !r)} />
            )}
            {kind !== 'docker' && <Reachability health={health} />}
          </>
        )}
      </div>

      <hr />
      <div className="flex flex-col gap-2.5">
        <StepHead n={2} title="Pick what counts as one flow" state={shipped ? 'done' : 'todo'} />
        <p className="text-muted-foreground text-xs">
          quiet stitches lines that share an id, checked in this order. You can change it per source later.
        </p>
        <div className="flex flex-wrap items-center gap-2.5">
          {ID_ORDER.map((id, i) => (
            <span key={id} className="flex items-center gap-1">
              <span className="font-mono text-[11px] text-muted-foreground">{i + 1}</span>
              <span className="bg-brand/15 px-1.5 py-0.5 font-mono text-[11px] text-brand">{id}</span>
            </span>
          ))}
        </div>
      </div>

      <hr />
      <div className="flex flex-col gap-2.5">
        <StepHead n={3} title="Wait for the first line" state={arrived ? 'done' : shipped ? 'active' : 'todo'} />
        {waiting && (
          <Wait kind={kind} waiting={waiting} arrived={arrived} name={name.trim()} token={token} origin={origin} />
        )}
      </div>
    </section>
  )
}

/** `/connect?kind=` — pick a source kind, get a token and a config, watch for the first line. */
export function ConnectPage() {
  const { kind } = route.useSearch()
  const selected = kind ?? 'docker'
  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-8">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-[28px] tracking-tight">Connect a source</h1>
        <p className="text-muted-foreground text-sm">
          Anything that already ships logs. Lines show up here in about a second.
        </p>
      </header>
      <div className="flex items-start gap-6">
        <div className="flex w-95 shrink-0 flex-col gap-2">
          {CONNECT_KINDS.map((k) => (
            <KindOption key={k} kind={k} selected={k === selected} />
          ))}
          <div className="flex flex-col gap-1.5 px-1 pt-3.5">
            <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">Not sure?</span>
            <p className="text-muted-foreground text-xs">
              Running on Dokploy, Coolify or plain compose? Pick Docker. Already have a log pipeline? Point Vector or
              Fluent Bit at quiet.
            </p>
          </div>
        </div>
        {/* A new kind starts a fresh panel (its own token, its own wait). */}
        <Panel key={selected} kind={selected} />
      </div>
    </div>
  )
}

/** First run, nothing sending yet: what quiet reads and where to start. */
export function Welcome() {
  const health = useHealth().data
  const pipe = 'bun run start | quiet pipe --name my-app'
  return (
    <div className="flex flex-1 flex-col justify-center gap-10 overflow-y-auto px-18 pb-10">
      <div className="flex flex-col gap-5">
        <span aria-hidden className="size-11 rounded-full border-[3px] border-brand" />
        <h1 className="font-semibold text-[40px] leading-11 tracking-tight">Nothing is sending lines yet.</h1>
        <p className="max-w-155 text-base text-muted-foreground">
          quiet reads anything that already ships logs. Pick how yours leave the box, choose one source, and watch it
          stream. Open any line to see its whole flow.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
          Connect your first source
        </span>
        <div className="flex flex-wrap gap-3">
          {CONNECT_KINDS.map((k) => (
            <Link
              key={k}
              to="/connect"
              search={{ kind: k }}
              className="flex w-49 flex-col gap-3.5 border bg-card p-4 outline-none hover:bg-muted/50 focus-visible:border-ring"
            >
              <span className="flex items-center justify-between">
                <span className="flex size-8 items-center justify-center border bg-secondary font-mono font-semibold text-[13px]">
                  {KIND_INFO[k].letter}
                </span>
                <ArrowRightIcon className="size-3.5 text-muted-foreground" />
              </span>
              <span className="flex flex-col gap-1">
                <span className="font-semibold text-sm">{KIND_INFO[k].title}</span>
                <span className="text-muted-foreground text-xs">{KIND_INFO[k].blurb}</span>
              </span>
            </Link>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2.5">
        <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">Or just pipe it</span>
        <div className="flex h-11 w-155 max-w-full items-center gap-3 border bg-code pr-1.5 pl-3.5 font-mono text-[13px]">
          <span className="text-muted-foreground">$</span>
          <span className="flex-1 truncate">{pipe}</span>
          <CopyButton text={pipe} variant="ghost" what="Command" />
        </div>
      </div>
      <p className="font-mono text-[11px] text-muted-foreground">
        self-hosted · {window.location.host} · {health ? `${Math.round(health.retention_ms / 3_600_000)}h` : '24h'}{' '}
        searchable window
      </p>
    </div>
  )
}
