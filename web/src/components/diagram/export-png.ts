import { countLabel, type DNode, type Graph, LAYOUT, type Layout, valueText } from '@/lib/diagram'

/** Longest side of the exported image, px (browsers refuse much larger canvases). */
const MAX_SIDE = 8192
const PAD = 24
const FONT = '12px "Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace'

type Palette = Record<
  | 'background'
  | 'card'
  | 'border'
  | 'muted'
  | 'mutedFg'
  | 'fg'
  | 'key'
  | 'string'
  | 'number'
  | 'literal'
  | 'error'
  | 'errorMuted'
  | 'brand',
  string
>

/** The theme's tokens as the page has them now (light or dark). */
function palette(): Palette {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    background: v('--background', '#0b0c0e'),
    card: v('--card', '#111215'),
    border: v('--border', 'rgba(255,255,255,0.08)'),
    muted: v('--muted', '#16171b'),
    mutedFg: v('--muted-foreground', '#8a8f98'),
    fg: v('--foreground', '#e8e9ec'),
    key: v('--syntax-key', '#9aa0ff'),
    string: v('--syntax-string', '#c9ccd2'),
    number: v('--syntax-number', '#e8b04a'),
    literal: v('--syntax-literal', '#3fcf8e'),
    error: v('--level-error', '#f27272'),
    errorMuted: v('--level-error-muted', 'rgba(242,85,90,0.15)'),
    brand: v('--brand', '#8087ff'),
  }
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid
    else hi = mid - 1
  }
  return `${text.slice(0, lo)}…`
}

function drawCard(ctx: CanvasRenderingContext2D, n: DNode, layout: Layout, p: Palette, flowIds: ReadonlySet<string>) {
  const b = layout.boxes.get(n.id)
  if (!b) return
  const L = LAYOUT
  ctx.fillStyle = p.card
  ctx.fillRect(b.x, b.y, b.w, b.h)
  ctx.fillStyle = n.error ? p.errorMuted : p.muted
  ctx.fillRect(b.x, b.y, b.w, L.header)
  ctx.strokeStyle = n.error ? p.error : p.border
  ctx.lineWidth = 1
  ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1)
  ctx.textBaseline = 'middle'
  const label = countLabel(n.kind, n.count)
  ctx.fillStyle = p.mutedFg
  ctx.textAlign = 'right'
  ctx.fillText(label, b.x + b.w - L.padX, b.y + L.header / 2)
  ctx.textAlign = 'left'
  ctx.fillStyle = n.error ? p.error : p.fg
  ctx.fillText(
    ellipsize(ctx, n.title, b.w - 3 * L.padX - ctx.measureText(label).width),
    b.x + L.padX,
    b.y + L.header / 2,
  )
  n.rows.forEach((r, i) => {
    const top = b.y + b.rowY[i]
    const mid = top + L.row / 2
    ctx.strokeStyle = p.border
    ctx.beginPath()
    ctx.moveTo(b.x, top + 0.5)
    ctx.lineTo(b.x + b.w, top + 0.5)
    ctx.stroke()
    let x = b.x + L.padX
    const right = b.x + b.w - L.padX - L.handle
    if (r.more) {
      ctx.fillStyle = p.brand
      ctx.fillText(
        ellipsize(ctx, `+ ${r.more.hidden} more · showing ${r.more.shown} of ${r.more.total}`, right - x),
        x,
        mid,
      )
      return
    }
    const key = `${r.key}: `
    ctx.fillStyle = p.key
    ctx.fillText(ellipsize(ctx, key, right - x), x, mid)
    x += ctx.measureText(key).width
    const text = valueText(r.value)
    ctx.fillStyle =
      r.kind === 'num'
        ? p.number
        : r.kind === 'bool' || r.kind === 'null'
          ? p.literal
          : r.kind === 'str' && r.value !== ''
            ? p.string
            : p.mutedFg
    const tag = flowIds.has(r.id) ? ' flow id' : ''
    const shown = ellipsize(ctx, text, Math.max(0, right - x - (tag ? ctx.measureText(tag).width + 8 : 0)))
    ctx.fillText(shown, x, mid)
    if (tag) {
      ctx.fillStyle = p.brand
      ctx.fillText(tag, x + ctx.measureText(shown).width + 4, mid)
    }
    if (r.count && r.count > 0) {
      // The −/+ handle on the card edge.
      const hx = b.x + b.w - 7
      ctx.fillStyle = p.card
      ctx.fillRect(hx, mid - 6, 12, 12)
      ctx.strokeStyle = p.mutedFg
      ctx.strokeRect(hx + 0.5, mid - 5.5, 11, 11)
      ctx.beginPath()
      ctx.moveTo(hx + 3, mid)
      ctx.lineTo(hx + 9, mid)
      if (!r.open) {
        ctx.moveTo(hx + 6, mid - 3)
        ctx.lineTo(hx + 6, mid + 3)
      }
      ctx.stroke()
    }
  })
}

/**
 * The diagram as drawn (open cards, current direction, the theme's colours)
 * on a canvas, at 2× when it fits. Values are the line as the server sent it,
 * so masked fields stay masked.
 */
export async function renderPng(g: Graph, layout: Layout, flowIds: ReadonlySet<string>): Promise<Blob | null> {
  const w = layout.width + PAD * 2
  const h = layout.height + PAD * 2
  const scale = Math.min(2, MAX_SIDE / w, MAX_SIDE / h)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = canvas.getContext('2d')
  } catch {
    ctx = null
  }
  if (!ctx) return null
  try {
    await document.fonts?.ready
  } catch {
    // Fonts not ready: the fallback monospace is fine.
  }
  const p = palette()
  ctx.scale(scale, scale)
  ctx.fillStyle = p.background
  ctx.fillRect(0, 0, w, h)
  // The dotted canvas, when it is not huge.
  if ((w / 20) * (h / 20) < 60_000) {
    ctx.fillStyle = p.border
    for (let x = 10; x < w; x += 20) for (let y = 10; y < h; y += 20) ctx.fillRect(x, y, 1.2, 1.2)
  }
  ctx.translate(PAD, PAD)
  ctx.font = FONT
  ctx.strokeStyle = p.mutedFg
  ctx.globalAlpha = 0.6
  ctx.lineWidth = 1
  for (const e of layout.edges) ctx.stroke(new Path2D(e.d))
  ctx.globalAlpha = 1
  for (const n of g.nodes) drawCard(ctx, n, layout, p, flowIds)
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
}
