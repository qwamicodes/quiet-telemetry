import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fitWidth, LogTable, REQUEST_COL } from '@/components/stream/log-table'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { LogLine } from '@/gen'
import { makeQueryClient } from '@/providers'

const line = (id: number, fields: Record<string, unknown>): LogLine => ({
  id,
  ts: 1_792_000_000_000 + id,
  received: 1_792_000_000_000 + id,
  source: 'api',
  level: 'info',
  display_id: null,
  ids: [],
  msg: '',
  fields,
  raw: JSON.stringify(fields),
})

const api = [
  line(1, { flow: 'list_orders', method: 'GET', path: '/api/v1/orders', status_code: 200, duration_ms: 39 }),
  line(2, { flow: 'list_payouts', method: 'GET', path: '/api/v1/dealers/88/payouts/history', status_code: 200 }),
]
const worker = [
  line(3, { flow: 'settle_dealer_payout', queue: 'payouts', job_id: 'payout-88-1300', attempt: 1, duration_ms: 640 }),
]

function renderTable(lines: LogLine[]) {
  const actions = { onSelect: vi.fn(), onOpenFlow: vi.fn(), onOpenDiagram: vi.fn(), onCopy: vi.fn(), onFilter: vi.fn() }
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <TooltipProvider>
        <LogTable
          lines={lines}
          selectedId={null}
          expandedId={null}
          follow
          onFollow={() => {}}
          empty="empty"
          actions={actions}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

describe('LogTable columns (v0.1.1-03.x)', () => {
  beforeEach(() => localStorage.clear())

  it('reads REQUEST · FLOW · RESULT for an HTTP source and JOB for a worker', () => {
    const { unmount } = renderTable(api)
    expect(screen.getByText('Request')).toBeInTheDocument()
    expect(screen.getByText('Flow · Result')).toBeInTheDocument()
    unmount()
    renderTable(worker)
    expect(screen.getByText('Job')).toBeInTheDocument()
  })

  it('resizes the REQUEST column from the keyboard, remembers it and resets', () => {
    renderTable(api)
    const handle = screen.getByRole('separator', { name: 'Resize Request column' })
    expect(handle).toHaveAttribute('aria-valuenow', String(REQUEST_COL.def))
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle).toHaveAttribute('aria-valuenow', String(REQUEST_COL.def + 16))
    expect(localStorage.getItem(REQUEST_COL.key)).toBe(String(REQUEST_COL.def + 16))
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })
    expect(handle).toHaveAttribute('aria-valuenow', String(REQUEST_COL.def + 16 - 64))
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(handle).toHaveAttribute('aria-valuenow', String(REQUEST_COL.def))
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent(
      `${REQUEST_COL.def} px · double-click to fit`,
    )
  })

  it('fits to the widest request and stays within limits', () => {
    expect(fitWidth(api)).toBeGreaterThan(REQUEST_COL.def)
    expect(fitWidth([])).toBe(REQUEST_COL.def)
    const long = line(9, { method: 'GET', path: `/${'x'.repeat(400)}`, status_code: 200 })
    expect(fitWidth([long])).toBe(REQUEST_COL.max)
  })
})
