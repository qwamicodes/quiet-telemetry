import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceLostBanner } from '@/components/stream/connection-banner'

describe('SourceLostBanner (03.7)', () => {
  afterEach(() => vi.useRealTimers())

  it('counts down to the server’s next reconnect attempt', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    render(
      <SourceLostBanner
        source="legivent-api"
        lastTs={null}
        docker={{ state: 'unavailable', error: 'connection refused', retry_at: 1_004_000, attempt: 3 }}
        onRetry={() => {}}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('reconnecting in 4s (attempt 3)')
  })

  it('without a schedule it just says reconnecting', () => {
    render(<SourceLostBanner source="legivent-api" lastTs={null} docker={{ state: 'connecting' }} onRetry={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Lost the docker stream for legivent-api · reconnecting ·')
  })
})
