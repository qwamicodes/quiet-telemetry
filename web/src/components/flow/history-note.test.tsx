import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { HistorySearchJob } from '@/gen'
import { FlowHistoryNote } from './history-note'

const H = 3_600_000
const NOV9 = Date.UTC(2026, 10, 9)
const history = { since: NOV9, until: NOV9 + 13 * 24 * H, found: false }
const job = (over: Partial<HistorySearchJob>): HistorySearchJob => ({
  id: 'hs_1',
  state: 'done',
  done: 6,
  total: 6,
  bytes: 0,
  downloaded: 0,
  matched: 2,
  lines: [],
  locations: {},
  histogram: null,
  failures: [],
  coverage: {
    from: 0,
    to: 0,
    hours: 0,
    archived: 0,
    destinations: [],
    gaps: [],
    expired_before: null,
    auto: false,
    truncated: false,
  },
  created: 0,
  offset: 0,
  count: 2,
  ...over,
})

describe('FlowHistoryNote', () => {
  it('offers to search retained history, then says what it added', async () => {
    const start = vi.fn()
    const { rerender } = render(
      <FlowHistoryNote history={history} job={null} starting={false} error={null} onStart={start} onCancel={vi.fn()} />,
    )
    expect(screen.getByText('Related history unavailable')).toBeInTheDocument()
    expect(screen.getByText(/may continue before 21 Nov/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Search retained history' }))
    expect(start).toHaveBeenCalled()
    rerender(
      <FlowHistoryNote
        history={{ ...history, found: true }}
        job={job({ state: 'retrieving', done: 2, count: 0 })}
        starting={false}
        error={null}
        onStart={start}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText(/Retrieving 2 of 6 hours of retained history/)).toBeInTheDocument()
    rerender(
      <FlowHistoryNote
        history={history}
        job={job({})}
        starting={false}
        error={null}
        onStart={start}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText('2 related events from retained history added')).toBeInTheDocument()
  })
})
