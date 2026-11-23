import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { HistoryCoverage, HistorySearchJob } from '@/gen'
import { fmtDays } from '@/lib/history-search'
import { HistoryPanel } from './history-panel'

const H = 3_600_000
const NOV9 = Date.UTC(2026, 10, 9)
const coverage: HistoryCoverage = {
  from: NOV9 - 48 * H,
  to: NOV9 + 13 * 24 * H,
  hours: 360,
  archived: 312,
  destinations: [
    { id: 1, name: 'garage-local', active: false, first: NOV9, last: NOV9 + 13 * 24 * H, hours: 312, percent: 62 },
    { id: 2, name: 'production-r2', active: true, first: null, last: null, hours: 0, percent: 0 },
  ],
  gaps: [{ from: NOV9 + 5 * 24 * H, to: NOV9 + 5 * 24 * H + 2 * H, reason: 'disk_cap' }],
  expired_before: NOV9,
  auto: false,
  truncated: true,
}
const job = (over: Partial<HistorySearchJob>): HistorySearchJob => ({
  id: 'hs_1',
  state: 'retrieving',
  done: 3,
  total: 13,
  bytes: 4_200_000,
  downloaded: 4_200_000,
  matched: 0,
  lines: [],
  locations: {},
  histogram: null,
  failures: [],
  coverage,
  created: 0,
  offset: 0,
  count: 0,
  ...over,
})
const panel = (j: HistorySearchJob | null, on = { start: vi.fn(), cancel: vi.fn() }) =>
  render(
    <HistoryPanel coverage={coverage} job={j} starting={false} error={null} onStart={on.start} onCancel={on.cancel} />,
  )

describe('HistoryPanel (v1.1-19 … 23)', () => {
  it('says what each destination covers, where history starts and what was not retained', async () => {
    const on = { start: vi.fn(), cancel: vi.fn() }
    panel(null, on)
    expect(screen.getByText('covers 09–21 Nov · 62%')).toBeInTheDocument()
    expect(screen.getByText('holds nothing in this range')).toBeInTheDocument()
    expect(screen.getByText('No retained history before 09 Nov.')).toBeInTheDocument()
    expect(screen.getByText(/Not retained 14 Nov: the disk cap dropped it first/)).toBeInTheDocument()
    expect(screen.getByText(/newest 168 hours/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Search retained history' }))
    expect(on.start).toHaveBeenCalled()
  })

  it('shows progress with cancel, then cancelled, incomplete and done', async () => {
    const on = { start: vi.fn(), cancel: vi.fn() }
    const { rerender } = panel(job({}), on)
    expect(screen.getByText(/Retrieving 3 of 13 hours · 4 MB/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(on.cancel).toHaveBeenCalled()
    const re = (j: HistorySearchJob) =>
      rerender(
        <HistoryPanel
          coverage={coverage}
          job={j}
          starting={false}
          error={null}
          onStart={on.start}
          onCancel={on.cancel}
        />,
      )
    re(job({ state: 'cancelled', count: 4 }))
    expect(screen.getByText('Cancelled · 4 found in 3 of 13 hours kept')).toBeInTheDocument()
    re(
      job({
        state: 'incomplete',
        done: 13,
        count: 2,
        failures: [
          { destination: 'garage-local', from: NOV9, to: NOV9 + 13 * 24 * H, hours: 10, error: 'connection refused' },
        ],
      }),
    )
    expect(screen.getByText(/Incomplete · 2 found · 3 of 13 hours searched/)).toBeInTheDocument()
    expect(screen.getByText(/garage-local not searched · 09–21 Nov · connection refused/)).toBeInTheDocument()
    re(job({ state: 'done', done: 13, count: 1 }))
    expect(screen.getByText('1 event from retained history · 13 hours searched')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Export' })).toHaveAttribute(
      'href',
      '/api/search/history/hs_1/export?format=ndjson',
    )
  })

  it('formats day ranges', () => {
    expect(fmtDays(NOV9, NOV9 + 13 * 24 * H)).toBe('09–21 Nov')
    expect(fmtDays(Date.UTC(2026, 9, 30), Date.UTC(2026, 10, 3))).toBe('30 Oct–02 Nov')
    expect(fmtDays(NOV9, NOV9 + H)).toBe('09 Nov')
  })
})
