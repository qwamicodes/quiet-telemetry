import { describe, expect, it } from 'vitest'
import type { LogLine } from '@/gen'
import { similarValues, stems } from '@/lib/similar'

const line = (fields: Record<string, unknown>): LogLine => ({
  id: 1,
  ts: 0,
  received: 0,
  source: 'order-worker',
  level: 'info',
  display_id: null,
  ids: [],
  msg: '',
  fields,
  raw: JSON.stringify(fields),
})

describe('similar values (05.3)', () => {
  it('stems the searched words', () => {
    expect(stems('payout_reversed')).toEqual(['payout', 'rever'])
    expect(stems('a to of')).toEqual([])
  })

  it('finds values that share a stem, most frequent first', () => {
    const lines = [
      line({ outcome: 'payout_failed', operation: 'reverse_payout', msg: 'payout_failed for dealer' }),
      line({ outcome: 'payout_failed', job: { name: 'settle' } }),
      line({ err: { code: 'REVERSAL_DENIED' }, request_id: 'req_payout_very_long_identifier_value_0123456789' }),
    ]
    expect(similarValues(lines, 'payout_reversed')).toEqual([
      'outcome:payout_failed',
      'err.code:REVERSAL_DENIED',
      'operation:reverse_payout',
    ])
  })
})
