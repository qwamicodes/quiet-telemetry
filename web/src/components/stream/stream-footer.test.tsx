import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StreamFooter } from '@/components/stream/stream-footer'

describe('StreamFooter (v0.1.1-03.8, 03.15, 03.17)', () => {
  it('shows the mute summary with Show muted, and ⌘Z undo mute in place of the keys', () => {
    const onToggle = vi.fn()
    render(
      <StreamFooter
        state="live"
        text="streaming"
        muted={{ rules: 1, count: 312, shown: false, onToggle, undo: true }}
      />,
    )
    expect(screen.getByTestId('muted-note')).toHaveTextContent('1 mute rule · 312 hidden')
    fireEvent.click(screen.getByRole('button', { name: 'Show muted' }))
    expect(onToggle).toHaveBeenCalled()
    expect(screen.getByText(/undo mute/)).toBeInTheDocument()
    expect(screen.queryByText(/shortcuts/)).not.toBeInTheDocument()
  })

  it('plural rules and the shown state', () => {
    render(
      <StreamFooter
        state="live"
        text="streaming"
        muted={{ rules: 3, count: 2, shown: true, onToggle: () => {}, undo: false }}
      />,
    )
    expect(screen.getByTestId('muted-note')).toHaveTextContent('3 mute rules · 2 muted · shown')
    expect(screen.getByRole('button', { name: 'Hide muted' })).toBeInTheDocument()
    expect(screen.getByText(/shortcuts/)).toBeInTheDocument()
  })

  it('a hint replaces the default keys (row hovered, picker open)', () => {
    render(<StreamFooter state="live" text="streaming" hint="one source at a time" />)
    expect(screen.getByText('one source at a time')).toBeInTheDocument()
    expect(screen.queryByText(/shortcuts/)).not.toBeInTheDocument()
  })
})
