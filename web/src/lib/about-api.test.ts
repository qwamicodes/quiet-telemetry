import { describe, expect, it } from 'vitest'
import { bumpKind, compareVersions, releaseBullets } from '@/lib/about-api'

describe('update check helpers', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('v0.1.10', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('v0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('0.1.0-rc.1', '0.1.0')).toBe(0)
    expect(compareVersions('0.0.9', '0.1.0')).toBeLessThan(0)
    expect(bumpKind('v0.2.0', '0.1.4')).toBe('minor')
    expect(bumpKind('v0.1.5', '0.1.4')).toBe('patch')
  })

  it('takes the first bullets of the release notes', () => {
    expect(releaseBullets('## Fixes\n- **Parser** keeps `ts`\n* two\ntext\n- three', 2)).toEqual([
      'Parser keeps ts',
      'two',
    ])
  })
})
