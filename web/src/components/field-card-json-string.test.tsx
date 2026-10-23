import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogLine } from '@/gen'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/lib/api', () => ({ useSources: () => ({ data: [] }) }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast }))

import { type DiagramMode, FieldCard } from '@/components/field-card'

const payload = JSON.stringify({ user: { id: 'u-42' }, items: 3 })
const fields = { method: 'POST', status: 201, payload, note: '{not json}', greeting: 'hello' }
const line: LogLine = {
  id: 11,
  ts: 1_700_000_000_000,
  received: 1_700_000_000_010,
  source: 'api',
  level: 'info',
  display_id: null,
  ids: [],
  msg: 'POST /orders',
  raw: JSON.stringify(fields),
  fields,
}

function row(key: string) {
  return screen.getByRole('button', { name: key, pressed: false }).parentElement as HTMLElement
}

describe('FieldCard with JSON held in strings', () => {
  let writeText: ReturnType<typeof vi.fn>
  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined)
  })
  afterEach(() => vi.clearAllMocks())

  it('Fields: nested dotted rows with a parsed badge; plain and invalid strings unchanged', () => {
    render(<FieldCard line={line} />)
    expect(screen.getByTestId('parsed-bar')).toHaveTextContent('1 string value parsed as JSON')
    const id = row('payload.user.id')
    expect(within(id).getByText('u-42')).toBeInTheDocument()
    expect(within(id).getByTestId('parsed-badge')).toHaveAttribute('title', 'Parsed from the JSON string in payload')
    expect(within(row('payload.items')).getByText('3')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'payload' })).not.toBeInTheDocument()
    expect(within(row('note')).getByText('{not json}')).toBeInTheDocument()
    expect(within(row('note')).queryByTestId('parsed-badge')).not.toBeInTheDocument()
    expect(within(row('greeting')).getByText('hello')).toBeInTheDocument()
  })

  it('Show as sent brings the string back, and Parse JSON flips it again', async () => {
    const user = userEvent.setup()
    render(<FieldCard line={line} />)
    await user.click(screen.getByRole('button', { name: 'Show as sent' }))
    expect(within(row('payload')).getByText(payload)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'payload.user.id' })).not.toBeInTheDocument()
    expect(screen.getByTestId('parsed-bar')).toHaveTextContent('shown as sent')
    await user.click(screen.getByRole('button', { name: 'Parse JSON' }))
    expect(row('payload.user.id')).toBeInTheDocument()
  })

  it('a nested value copies by itself and searches the text (search cannot look inside strings)', async () => {
    const user = userEvent.setup()
    render(<FieldCard line={line} />)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await user.click(within(row('payload.user.id')).getByRole('button', { name: 'Copy value' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('u-42'))
    expect(toast.success).toHaveBeenCalledWith('Copied payload.user.id')
    await user.click(screen.getByRole('button', { name: 'payload.user.id' }))
    const search = screen.getByRole('button', { name: 'Search for payload.user.id' })
    await user.click(search)
    expect(navigate).toHaveBeenCalledWith({ to: '/search', search: { q: '"u-42"' } })
  })

  it('a real field still filters by key', async () => {
    const user = userEvent.setup()
    render(<FieldCard line={line} />)
    await user.click(screen.getByRole('button', { name: 'method' }))
    await user.click(screen.getByRole('button', { name: 'Filter by method' }))
    expect(navigate).toHaveBeenCalledWith({ to: '/search', search: { q: 'method:POST' } })
  })

  it('JSON tab pretty-prints the parsed value, and as sent shows the string', async () => {
    const user = userEvent.setup()
    render(<FieldCard line={line} />)
    await user.click(screen.getByRole('tab', { name: 'JSON' }))
    const view = screen.getByTestId('json-view')
    expect(view).toHaveTextContent('"id": "u-42"')
    expect(view).not.toHaveTextContent('\\"user\\"')
    await user.click(screen.getByRole('button', { name: 'Show as sent' }))
    expect(screen.getByTestId('json-view')).toHaveTextContent('\\"user\\"')
  })

  it('a line without JSON strings shows no bar', () => {
    render(<FieldCard line={{ ...line, id: 12, fields: { a: 'x', b: 2 } }} />)
    expect(screen.queryByTestId('parsed-bar')).not.toBeInTheDocument()
  })

  it('Diagram draws the parsed value as a card marked "from string"', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [mode, setMode] = useState<DiagramMode>('off')
      return <FieldCard line={line} diagram={mode} onDiagramChange={setMode} />
    }
    render(<Harness />)
    await user.click(screen.getByRole('tab', { name: /Diagram/ }))
    await screen.findByTestId('diagram-canvas', undefined, { timeout: 5000 })
    const card = document.querySelector('[data-node=".payload"]') as HTMLElement
    expect(card).not.toBeNull()
    expect(within(card).getByTestId('parsed-card')).toHaveTextContent('from string')
  })
})
