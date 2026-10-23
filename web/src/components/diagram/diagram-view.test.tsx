import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogLine } from '@/gen'
import { checkout } from '@/test/diagram-fixtures'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/lib/api', () => ({ useSources: () => ({ data: [] }) }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast }))

import { type DiagramMode, FieldCard } from '@/components/field-card'
import { STRUCTURED_ONLY } from '@/lib/diagram-stats'

const line: LogLine = {
  id: 7,
  ts: 1_761_094_394_226,
  received: 1_761_094_394_231,
  source: 'legivent-api',
  level: 'error',
  display_id: { key: 'request_id', value: checkout.request_id },
  ids: [{ key: 'request_id', value: checkout.request_id }],
  msg: 'GET /api/v1/checkout/sessions/chk_vH3z…W1aB',
  raw: JSON.stringify(checkout),
  fields: checkout,
}

const plain: LogLine = {
  ...line,
  id: 8,
  source: 'traefik',
  level: 'warn',
  display_id: null,
  ids: [],
  raw: '102.176.65.14 - - [22/Oct/2026:00:53:14 +0000] "GET /api/v1/checkout/sessions/chk HTTP/1.1" 404 19',
  fields: undefined,
}

/** The card as a flow holds it: Diagram mode lifted into the owner. */
function Owner({ l = line, initial = 'off' as DiagramMode }: { l?: LogLine; initial?: DiagramMode }) {
  const [mode, setMode] = useState<DiagramMode>(initial)
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <FieldCard line={l} diagram={mode} onDiagramChange={setMode} />
    </div>
  )
}

const openDiagram = async () => {
  render(<Owner initial="wide" />)
  return screen.findByTestId('diagram-canvas', undefined, { timeout: 5000 })
}

describe('Diagram tab', () => {
  let writeText: ReturnType<typeof vi.fn>
  beforeEach(() => {
    localStorage.clear()
    writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  })
  afterEach(() => vi.clearAllMocks())

  it('is the 4th tab and switching to it widens the card; another tab shrinks it back', async () => {
    const user = userEvent.setup()
    render(<Owner />)
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent)
    expect(tabs).toEqual(['Fields', 'JSON', 'Raw', 'Diagram'])
    await user.click(screen.getByRole('tab', { name: /Diagram/ }))
    expect(screen.getByTestId('mode')).toHaveTextContent('wide')
    expect(await screen.findByTestId('diagram-canvas', undefined, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByTestId('diagram-stats')).toHaveTextContent(/28 keys · 4 objects · depth 2 · \d+ B/)
    await user.click(screen.getByRole('tab', { name: 'JSON' }))
    expect(screen.getByTestId('mode')).toHaveTextContent('off')
    expect(screen.getByTestId('json-view')).toBeInTheDocument()
  })

  it('draws a card per object with typed rows and the flow id tag', async () => {
    await openDiagram()
    const cards = screen.getAllByRole('region').map((c) => c.getAttribute('aria-label'))
    expect(cards).toEqual(expect.arrayContaining(['root', 'wideEvents', 'session', 'error']))
    const root = screen.getByRole('region', { name: 'root' })
    expect(within(root).getByText('{17 keys}')).toBeInTheDocument()
    const req = within(root).getByRole('button', { name: 'request_id' })
    expect(within(req).getByText('flow id')).toBeInTheDocument()
    const level = within(root).getByRole('button', { name: 'level' })
    expect(within(level).getByText('error')).toBeInTheDocument()
    expect(within(root).getByRole('button', { name: 'Copy status' })).toHaveClass('text-syntax-number')
    expect(within(root).getByRole('button', { name: 'Copy should_sample' })).toHaveClass('text-syntax-literal')
  })

  it('clicking a value copies it (strings unquoted) and toasts the key', async () => {
    const user = userEvent.setup()
    await openDiagram()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await user.click(screen.getByRole('button', { name: 'Copy hostname' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('1a3a848cdd6d'))
    expect(toast.success).toHaveBeenCalledWith('Copied hostname')
  })

  it('Esc goes back to the card; full screen first exits full screen', async () => {
    render(<Owner initial="full" />)
    await screen.findByTestId('diagram-canvas', undefined, { timeout: 5000 })
    expect(screen.getByRole('region', { name: 'Line details' })).toHaveAttribute('data-diagram', 'full')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('mode')).toHaveTextContent('wide')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('mode')).toHaveTextContent('off')
    expect(screen.queryByTestId('diagram-canvas')).not.toBeInTheDocument()
  })

  it('Esc in the diagram never reaches the page underneath', async () => {
    const page = vi.fn()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && page()
    window.addEventListener('keydown', onKey)
    await openDiagram()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(page).not.toHaveBeenCalled()
    window.removeEventListener('keydown', onKey)
  })

  it('search: "/" opens it, counts matches, Enter steps, dims cards without one, Esc closes', async () => {
    const user = userEvent.setup()
    await openDiagram()
    fireEvent.keyDown(window, { key: '/' })
    const input = await screen.findByRole('textbox', { name: 'Search keys and values' })
    await act(async () => {
      fireEvent.change(input, { target: { value: 'checkout_session' } })
    })
    expect(screen.getByTestId('diagram-match-count')).toHaveTextContent('1 / 5')
    await user.type(input, '{Enter}')
    expect(screen.getByTestId('diagram-match-count')).toHaveTextContent('2 / 5')
    expect(screen.getByTestId('diagram-status')).toHaveTextContent('5 matches in 2 objects · 2 / 5 · wideEvents.flow')
    expect(screen.getByRole('region', { name: 'session' })).toHaveClass('opacity-40')
    expect(screen.getByRole('region', { name: 'wideEvents' })).not.toHaveClass('opacity-40')
    await user.type(input, '{Shift>}{Enter}{/Shift}')
    expect(screen.getByTestId('diagram-match-count')).toHaveTextContent('1 / 5')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Search keys and values' })).not.toBeInTheDocument()
    expect(screen.getByTestId('mode')).toHaveTextContent('wide')
  })

  it('search opens collapsed branches that hold a match', async () => {
    const user = userEvent.setup()
    await openDiagram()
    await user.click(screen.getByRole('button', { name: 'Collapse wideEvents' }))
    expect(screen.queryByRole('region', { name: 'wideEvents' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand wideEvents' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: '/' })
    const input = await screen.findByRole('textbox', { name: 'Search keys and values' })
    await act(async () => {
      fireEvent.change(input, { target: { value: 'missing_cookie' } })
    })
    expect(screen.getByRole('region', { name: 'session' })).toBeInTheDocument()
  })

  it('collapse keeps the {n keys} label and is remembered per source', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Owner initial="wide" />)
    await screen.findByTestId('diagram-canvas', undefined, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Collapse error' }))
    const root = screen.getByRole('region', { name: 'root' })
    expect(within(within(root).getByRole('button', { name: 'error' })).getByText('{2 keys}')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'error' })).not.toBeInTheDocument()
    unmount()
    render(<Owner initial="wide" />)
    await screen.findByTestId('diagram-canvas', undefined, { timeout: 5000 })
    expect(screen.queryByRole('region', { name: 'error' })).not.toBeInTheDocument()
  })

  it('row menu: copy path, filter, exclude, highlight and use as a flow id', async () => {
    const user = userEvent.setup()
    await openDiagram()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const row = screen.getByRole('button', { name: 'checkout_session_id' })
    fireEvent.contextMenu(row)
    const menu = screen.getByRole('menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent?.replace(/[✓\d]/g, '')),
    ).toEqual([
      'Copy valueC',
      'Copy pathwideEvents.checkout_session_id',
      'Filter by valueF',
      'Exclude value⇧F',
      'Highlight this value',
      'Use as a flow id…',
    ])
    await user.click(within(menu).getByRole('menuitem', { name: /Copy path/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('wideEvents.checkout_session_id'))

    fireEvent.contextMenu(row)
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Filter by value/ }))
    expect(navigate).toHaveBeenLastCalledWith({
      to: '/search',
      search: { q: 'wideEvents.checkout_session_id:chk_vH3zF9QmR8kL2pT7xN4cW1aB' },
    })

    fireEvent.contextMenu(row)
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Exclude value/ }))
    expect(navigate).toHaveBeenLastCalledWith({
      to: '/search',
      search: { q: '-wideEvents.checkout_session_id:chk_vH3zF9QmR8kL2pT7xN4cW1aB' },
    })

    fireEvent.contextMenu(row)
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Highlight this value/ }))
    // The same id inside `path` is marked too.
    const path = screen.getByRole('button', { name: 'Copy path' })
    expect(within(path).getByText('chk_vH3zF9QmR8kL2pT7xN4cW1aB').tagName).toBe('MARK')
    expect(screen.getByTestId('diagram-status')).toHaveTextContent('same value highlighted in path')

    fireEvent.contextMenu(row)
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Use as a flow id/ }))
    expect(navigate).toHaveBeenLastCalledWith({
      to: '/settings/flow-id-order',
      search: { add: 'wideEvents.checkout_session_id' },
    })
  })

  it('C copies the selected value, F filters by it', async () => {
    const user = userEvent.setup()
    await openDiagram()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await user.click(screen.getByRole('button', { name: 'method' }))
    fireEvent.keyDown(window, { key: 'c' })
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('GET'))
    fireEvent.keyDown(window, { key: 'f' })
    expect(navigate).toHaveBeenLastCalledWith({ to: '/search', search: { q: 'method:GET' } })
  })

  it('large lines: deep branches start collapsed, arrays cap at 5 with "+ N more", notice offers Expand all', async () => {
    const user = userEvent.setup()
    const big = {
      job_id: 'payout:88:1300',
      wideEvents: {
        calls: Array.from({ length: 14 }, (_, i) => ({ name: `call_${i}`, n: i })),
        provider: { response: { data: { deep: { deeper: 1 } } } },
      },
      ...Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i])),
    }
    render(<Owner l={{ ...line, raw: JSON.stringify(big), fields: big }} initial="wide" />)
    await screen.findByTestId('diagram-canvas', undefined, { timeout: 5000 })
    expect(screen.getByText(/Large line · \d+ keys/)).toBeInTheDocument()
    const calls = screen.getByRole('region', { name: 'calls' })
    expect(within(calls).getByText('+ 9 more')).toBeInTheDocument()
    expect(within(calls).getByText('· showing 5 of 14')).toBeInTheDocument()
    // wideEvents (1) → provider (2) → response (3) open; data (4) starts collapsed.
    expect(screen.getByRole('region', { name: 'response' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'data' })).not.toBeInTheDocument()
    expect(screen.getByTestId('diagram-status')).toHaveTextContent('calls[5…13] hidden')
    await user.click(screen.getByRole('button', { name: /Expand all/ }))
    expect(screen.getByRole('region', { name: 'deep' })).toBeInTheDocument()
    await user.click(within(calls).getByText('+ 9 more'))
    expect(
      within(screen.getByRole('region', { name: 'calls' })).getByRole('button', { name: '13' }),
    ).toBeInTheDocument()
  })

  it('toolbar: zoom steps, fit and settings persist locally', async () => {
    const user = userEvent.setup()
    await openDiagram()
    expect(screen.getByRole('button', { name: 'Zoom to 100%' })).toHaveTextContent('100%')
    await user.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByRole('button', { name: 'Zoom to 100%' })).toHaveTextContent('110%')
    fireEvent.keyDown(window, { key: '-' })
    fireEvent.keyDown(window, { key: '-' })
    expect(screen.getByRole('button', { name: 'Zoom to 100%' })).toHaveTextContent('90%')
    await user.click(screen.getByRole('button', { name: 'Diagram settings' }))
    await user.click(await screen.findByRole('button', { name: 'Top → down' }))
    await user.click(screen.getByRole('switch', { name: 'Wrap long values' }))
    expect(JSON.parse(localStorage.getItem('quiet.diagram.settings') ?? '{}')).toMatchObject({
      direction: 'tb',
      wrap: true,
    })
  })
})

describe('plain-text line', () => {
  it('JSON and Diagram stay visible but disabled, with a tooltip; the card opens on Raw', async () => {
    const user = userEvent.setup()
    render(<Owner l={plain} />)
    expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true')
    const diagram = screen.getByRole('tab', { name: /Diagram/ })
    const json = screen.getByRole('tab', { name: 'JSON' })
    expect(diagram).toHaveAttribute('aria-disabled', 'true')
    expect(json).toHaveAttribute('aria-disabled', 'true')
    await user.hover(diagram.parentElement as HTMLElement)
    expect(await screen.findByText(STRUCTURED_ONLY)).toBeInTheDocument()
    expect(screen.getByTestId('raw-view')).toHaveTextContent('102.176.65.14')
  })

  it('a requested diagram on a plain-text line stays on Raw', () => {
    render(<Owner l={plain} initial="wide" />)
    expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByTestId('diagram-canvas')).not.toBeInTheDocument()
  })
})
