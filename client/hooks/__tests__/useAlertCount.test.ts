import { describe, expect, it } from 'vitest'
import { useAlertCount } from '../useAlertCount.ts'

describe('useAlertCount', () => {
  it('is zero until the overview route returns alerts (prd-02 w2)', () => {
    expect(useAlertCount()).toBe(0)
  })
})
