import { ArrowDownIcon, ArrowRightIcon, ChevronsUpDownIcon, CornerDownRightIcon, RotateCwIcon } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { FlowMinimap } from '@/components/flow/minimap'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { Flow, FlowEdge, FlowNode } from '@/gen'
import { type FlowItem, flowItems, fmtDuration, nodeTone } from '@/lib/flow'
import { cn } from '@/lib/utils'

function NodeCard({ node, selected, onSelect }: { node: FlowNode; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Step ${node.name}`}
      aria-pressed={selected}
      data-node={node.index}
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-1 border bg-card px-3 py-2 text-left font-mono text-xs hover:bg-row-hover',
        node.error && 'border-status-err/50 bg-status-err/10',
        node.warn && 'border-status-warn/50 bg-status-warn/10',
        selected && 'outline-2 outline-brand',
      )}
    >
      <span className="flex items-center gap-2">
        <StatusDot status={nodeTone(node)} />
        <span className="min-w-0 flex-1 truncate font-medium text-[13px]">{node.name}</span>
        <span
          className={cn(
            'tabular-nums',
            node.error ? 'text-status-err' : node.warn ? 'text-status-warn' : 'text-muted-foreground',
          )}
        >
          {fmtDuration(node.duration_ms)}
        </span>
      </span>
      {node.summary && (
        <span
          className={cn(
            'truncate',
            node.error ? 'text-status-err' : node.warn ? 'text-status-warn' : 'text-muted-foreground',
          )}
        >
          {node.summary}
        </span>
      )}
      {node.children.length > 0 && (
        <span className="mt-1 flex flex-col gap-1 border border-dashed p-1.5">
          {node.children.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: children never reorder
            <span key={i} className="flex items-center gap-2">
              <StatusDot status={c.error ? 'err' : 'idle'} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              {c.summary && <span className="max-w-[45%] truncate text-muted-foreground">{c.summary}</span>}
              <span className="text-muted-foreground tabular-nums">{fmtDuration(c.duration_ms)}</span>
            </span>
          ))}
        </span>
      )}
    </button>
  )
}

function Connector({ edge, lanes, nodes }: { edge: FlowEdge; lanes: string[]; nodes: FlowNode[] }) {
  const to = nodes[edge.to]
  const toLane = lanes.indexOf(to.source)
  if (edge.kind === 'handoff') {
    const fromLane = lanes.indexOf(nodes[edge.from].source)
    const lo = Math.min(fromLane, toLane)
    const hi = Math.max(fromLane, toLane)
    return (
      <div
        className="flex items-center gap-2 border-brand/60 border-t border-dashed pt-1 font-mono text-[11px] text-brand"
        style={{ gridColumn: `${lo + 1} / ${hi + 2}` }}
      >
        <ArrowRightIcon className="size-3" />
        {edge.via ? `${edge.via.key} ${edge.via.value}` : `from ${nodes[edge.from].source}`}
        <span className="text-muted-foreground">+{fmtDuration(edge.gap_ms)}</span>
      </div>
    )
  }
  if (edge.kind === 'child') {
    // Span tree: the parent span this one ran inside.
    return (
      <div
        className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground"
        style={{ gridColumn: toLane + 1, paddingLeft: `${16 + to.depth * 16}px` }}
      >
        <CornerDownRightIcon className="size-3 opacity-60" />
        in {nodes[edge.from].name}
        <span>+{fmtDuration(edge.gap_ms)}</span>
      </div>
    )
  }
  return (
    <div
      className={cn(
        'flex items-center gap-2 pl-4 font-mono text-[11px]',
        edge.kind === 'retry' ? 'text-status-warn' : 'text-muted-foreground',
      )}
      style={{ gridColumn: toLane + 1 }}
    >
      {edge.kind === 'retry' ? (
        <>
          <RotateCwIcon className="size-3" />
          retry · backoff {fmtDuration(edge.gap_ms)}
        </>
      ) : (
        <ArrowDownIcon className="size-3 opacity-50" />
      )}
    </div>
  )
}

function RunCard({ item, onExpand }: { item: Extract<FlowItem, { kind: 'run' }>; onExpand: () => void }) {
  return (
    <div className="flex items-center gap-3 border border-dashed bg-card/50 px-3 py-2 font-mono text-xs">
      <ChevronsUpDownIcon className="size-3.5 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium text-[13px]">{item.nodes.length} steps collapsed</span>
        <span className="truncate text-muted-foreground">
          {item.name} ×{item.nodes.length} · {item.nodes.length - item.warn} ok
        </span>
      </span>
      <span className="text-muted-foreground tabular-nums">{fmtDuration(item.duration)}</span>
      <button type="button" onClick={onExpand} className="text-brand hover:underline">
        expand
      </button>
    </div>
  )
}

/**
 * Step nodes in lanes (one column per source), in the order the work started.
 * Handoffs between sources say which id carried them; retries their backoff.
 */
export function FlowGraph({
  flow,
  selected,
  onSelect,
}: {
  flow: Flow
  selected: number | null
  onSelect: (lineId: number) => void
}) {
  const [problemsOnly, setProblemsOnly] = useState(false)
  const [expandAll, setExpandAll] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [zoom, setZoom] = useState(1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const items = useMemo(
    () => flowItems(flow.nodes, { problemsOnly, expanded, expandAll }),
    [flow.nodes, problemsOnly, expanded, expandAll],
  )
  const lanes = flow.sources
  const incoming = useMemo(() => new Map(flow.edges.map((e) => [e.to, e])), [flow.edges])
  const foldable = flow.nodes.length > 8 || items.some((i) => i.kind === 'run') || expanded.size > 0 || expandAll

  return (
    <section aria-label="Flow steps" className="relative flex min-h-0 flex-1 flex-col border">
      {foldable && (
        <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
          <ToggleGroup
            aria-label="Steps"
            value={[problemsOnly ? 'problems' : 'all']}
            onValueChange={(v: string[]) => v[0] && setProblemsOnly(v[0] === 'problems')}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="all">All steps</ToggleGroupItem>
            <ToggleGroupItem value="problems">Problems only</ToggleGroupItem>
          </ToggleGroup>
          <Button variant="outline" size="sm" onClick={() => setExpandAll((x) => !x)}>
            <ChevronsUpDownIcon />
            {expandAll ? 'Collapse runs' : 'Expand all'}
          </Button>
        </div>
      )}
      {foldable && <FlowMinimap items={items} lanes={lanes} scrollRef={scrollRef} gridRef={gridRef} zoom={zoom} />}
      <div ref={scrollRef} className={cn('relative min-h-0 flex-1 overflow-auto p-6', foldable && 'pt-14 pr-14')}>
        <div
          ref={gridRef}
          className="relative grid origin-top-left gap-x-10 gap-y-2"
          style={{
            gridTemplateColumns: `repeat(${lanes.length}, minmax(240px, 320px))`,
            transform: zoom === 1 ? undefined : `scale(${zoom})`,
          }}
        >
          {lanes.map((l) => (
            <div key={l} className="pb-2 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
              {l}
            </div>
          ))}
          {items.map((it) => {
            if (it.kind === 'run') {
              return (
                <div key={it.key} data-mm={it.key} style={{ gridColumn: lanes.indexOf(it.nodes[0].source) + 1 }}>
                  <RunCard item={it} onExpand={() => setExpanded((s) => new Set([...s, it.key]))} />
                </div>
              )
            }
            const edge = incoming.get(it.node.index)
            return [
              edge && <Connector key={`e${it.node.index}`} edge={edge} lanes={lanes} nodes={flow.nodes} />,
              <div
                key={`n${it.node.index}`}
                data-mm={`n${it.node.index}`}
                style={{ gridColumn: lanes.indexOf(it.node.source) + 1, paddingLeft: `${it.node.depth * 16}px` }}
              >
                <NodeCard
                  node={it.node}
                  selected={selected === it.node.line_id}
                  onSelect={() => onSelect(it.node.line_id)}
                />
              </div>,
            ]
          })}
        </div>
      </div>
      <div className="absolute bottom-3 left-3 flex items-center border bg-popover font-mono text-xs">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}
        >
          −
        </Button>
        <span className="w-12 text-center text-muted-foreground tabular-nums">{Math.round(zoom * 100)}%</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom in"
          onClick={() => setZoom((z) => Math.min(1.5, z + 0.1))}
        >
          +
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom(1)}>
          Fit
        </Button>
      </div>
    </section>
  )
}
