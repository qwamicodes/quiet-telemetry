import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogLine } from '@/gen'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/lib/api', () => ({ useSources: () => ({ data: [] }) }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast }))

import { copyText, FieldCard } from '@/components/field-card'

const long = `x${'y'.repeat(500)}`
const line: LogLine = {
  id: 1,
  ts: 1_700_000_000_000,
  received: 1_700_000_000_010,
  source: 'api',
  level: 'info',
  display_id: null,
  ids: [],
  msg: 'POST /api/v1/payouts',
  raw: '{}',
  fields: {
    method: 'POST',
    status: 201,
    sampled: true,
    retries_left: null,
    tags: ['a', 'b'],
    note: long,
  },
}

function row(key: string) {
  return screen.getByRole('button', { name: key, pressed: false }).parentElement as HTMLElement
}

describe('FieldCard value copy', () => {
  let writeText: ReturnType<typeof vi.fn>
  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  })
  afterEach(() => vi.clearAllMocks())

  it('copyText: strings unquoted, the rest as JSON', () => {
    expect(copyText('POST')).toBe('POST')
    expect(copyText(201)).toBe('201')
    expect(copyText(true)).toBe('true')
    expect(copyText(null)).toBe('null')
    expect(copyText(['a', 'b'])).toBe('["a","b"]')
    expect(copyText({ a: 1 })).toBe('{"a":1}')
  })

  it('clicking a value copies it raw and toasts the key, without picking the row', async () => {
    const user = userEvent.setup()
    render(<FieldCard line={line} />)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const value = within(row('method')).getByRole('button', { name: 'Copy value' })
    expect(value).toHaveAttribute('title', 'Copy value')
    await user.click(value)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('POST'))
    expect(toast.success).toHaveBeenCalledWith('Copied method')
    // The row was not picked by the value click.
    expect(screen.getByRole('button', { name: 'method' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Filter by value' })).toBeDisabled()
  })

  it('copies numbers, bools, null and arrays as text', async () => {
    const user = userEvent.setup()
    render(<FieldCard line={line} />)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    for (const [k, want] of [
      ['status', '201'],
      ['sampled', 'true'],
      ['retries_left', 'null'],
      ['tags', '["a","b"]'],
    ]) {
      await user.click(within(row(k)).getByRole('button', { name: 'Copy value' }))
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(want))
    }
  })

  it('long values copy in full', async () => {
    const user = userEvent.setup()
    render(<FieldCard line={line} />)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await user.click(within(row('note')).getByRole('button', { name: 'Copy value' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(long))
  })

  it('is keyboard accessible (Enter and Space)', async () => {
    const user = userEvent.setup()
    render(<FieldCard line={line} />)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const value = within(row('method')).getByRole('button', { name: 'Copy value' })
    value.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    await user.keyboard(' ')
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
  })

  it('the rest of the row still picks the field for Filter by value', async () => {
    const user = userEvent.setup()
    render(<FieldCard line={line} />)
    await user.click(screen.getByRole('button', { name: 'method' }))
    expect(screen.getByRole('button', { name: 'method' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Filter by method' })).toBeEnabled()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('toasts an error when the clipboard is unavailable', async () => {
    render(<FieldCard line={line} />)
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    fireEvent.click(within(row('method')).getByRole('button', { name: 'Copy value' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
  })
})
