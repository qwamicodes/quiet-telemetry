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
    <HistoryPanel
      coverage={coverage}
      job={j}
      starting={false}
      localWindowMs={86_400_000}
      error={null}
      onStart={on.start}
      onCancel={on.cancel}
    />,
  )

describe('HistoryPanel (v1.1-19, 20, 21, 27)', () => {
  it('shows where history is available, each location and what was not retained', async () => {
    const on = { start: vi.fn(), cancel: vi.fn() }
    panel(null, on)
    expect(screen.getByText('History available · 09 Nov — now')).toBeInTheDocument()
    expect(screen.getByText('Recent · 24h')).toBeInTheDocument()
    // Only locations holding hours in the range are listed.
    expect(screen.getByText('Garage · history')).toBeInTheDocument()
    expect(screen.queryByText(/production-r2/)).not.toBeInTheDocument()
    expect(screen.getByText('No retained history before 09 Nov.')).toBeInTheDocument()
    expect(screen.getByText(/Not retained 14 Nov: the disk cap dropped it first/)).toBeInTheDocument()
    expect(screen.getByText(/newest 168 hours/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Search retained history' }))
    expect(on.start).toHaveBeenCalled()
  })

  it('shows retrieval per location with cancel, then cancelled, incomplete and done', async () => {
    const on = { start: vi.fn(), cancel: vi.fn() }
    const { rerender } = panel(job({}), on)
    expect(screen.getByText('Searching stored history')).toBeInTheDocument()
    expect(screen.getByText('Retrieving matching events')).toBeInTheDocument()
    expect(screen.getByText('Garage · 3 of 13 hours searched')).toBeInTheDocument()
    expect(screen.getByText('Last 24h · complete')).toBeInTheDocument()
    expect(screen.getByText(`${fmtDays(NOV9, NOV9 + 13 * 24 * H + H)} · searching`)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel search' }))
    expect(on.cancel).toHaveBeenCalled()
    const re = (j: HistorySearchJob) =>
      rerender(
        <HistoryPanel
          coverage={coverage}
          job={j}
          starting={false}
          localWindowMs={86_400_000}
          error={null}
          onStart={on.start}
          onCancel={on.cancel}
        />,
      )
    re(job({ state: 'cancelled', count: 4 }))
    expect(screen.getByText('Search cancelled · results are incomplete')).toBeInTheDocument()
    expect(screen.getByText('4 matches found before cancellation')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Run again' }))
    expect(on.start).toHaveBeenCalledTimes(1)
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
    expect(screen.getByText('Results are incomplete')).toBeInTheDocument()
    expect(screen.getByText(/Garage could not be searched for 09–21 Nov/)).toBeInTheDocument()
    expect(screen.getByText('1 of 2 locations searched')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry Garage' }))
    expect(on.start).toHaveBeenCalledTimes(2)
    re(job({ state: 'done', done: 13, count: 1 }))
    expect(screen.getByText(/1 event from retained history/)).toBeInTheDocument()
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
