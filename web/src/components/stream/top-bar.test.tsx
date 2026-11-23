import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LiveIndicator } from '@/components/stream/top-bar'

describe('LiveIndicator (v0.1.1-08.4)', () => {
  it('Connecting carries a progress bar; Live does not', () => {
    const { rerender } = render(<LiveIndicator state="connecting" rate={null} />)
    expect(screen.getByText('Connecting')).toBeInTheDocument()
    expect(screen.getByTestId('connecting-progress')).toBeInTheDocument()
    rerender(<LiveIndicator state="live" rate={4} />)
    expect(screen.queryByTestId('connecting-progress')).not.toBeInTheDocument()
  })
})
