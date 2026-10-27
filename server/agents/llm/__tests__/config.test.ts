import { format } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadLlmConfig } from '../config.ts'

// The model path's configuration (#429; prd-04 Rulings 4 and 9). Every
// value is invented.

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('loadLlmConfig', () => {
  it('defaults to Haiku, a 25-row batch, a 200,000-token day and no key', () => {
    const config = loadLlmConfig({})
    expect(Object.keys(config).sort()).toEqual(
      ['apiKey', 'batchSize', 'categoryModel', 'dailyTokenBudget', 'killSwitch', 'prices'].sort(),
    )
    expect(config).toEqual({
      apiKey: null,
      killSwitch: false,
      dailyTokenBudget: 200_000,
      categoryModel: 'claude-haiku-5-5',
      batchSize: 25,
      prices: new Map([['claude-haiku-5-5', { input: 100_000, output: 500_000 }]]),
    })
  })

  it('prices the configured model in micro-USD per million tokens', () => {
    const config = loadLlmConfig({})
    // $0.10 and $0.50 per million tokens.
    expect(config.prices.get(config.categoryModel)).toEqual({ input: 100_000, output: 500_000 })
  })

  it('reads the key, trimmed, and treats a blank one as none', () => {
    expect(loadLlmConfig({ ANTHROPIC_API_KEY: 'sk-ant-test-invented\n' }).apiKey).toBe(
      'sk-ant-test-invented',
    )
    expect(loadLlmConfig({ ANTHROPIC_API_KEY: '' }).apiKey).toBeNull()
    expect(loadLlmConfig({ ANTHROPIC_API_KEY: '   ' }).apiKey).toBeNull()
  })

  it.each(['1', 'on', 'true', '0', 'false', 'no', ' x '])(
    'treats AGENT_KILL_SWITCH=%j as on (fail-safe)',
    (value) => {
      expect(loadLlmConfig({ AGENT_KILL_SWITCH: value }).killSwitch).toBe(true)
    },
  )

  it.each([undefined, '', '  '])('treats AGENT_KILL_SWITCH=%j as off', (value) => {
    expect(loadLlmConfig({ AGENT_KILL_SWITCH: value }).killSwitch).toBe(false)
  })

  it('takes a budget of digits', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(loadLlmConfig({ AGENT_DAILY_TOKEN_BUDGET: '5000' }).dailyTokenBudget).toBe(5000)
    expect(loadLlmConfig({ AGENT_DAILY_TOKEN_BUDGET: '' }).dailyTokenBudget).toBe(200_000)
    expect(loadLlmConfig({ AGENT_DAILY_TOKEN_BUDGET: ' ' }).dailyTokenBudget).toBe(200_000)
    expect(warn).not.toHaveBeenCalled()
  })

  it.each(['0', '-1', '1.5', '1e6', '0x10', ' 5000', 'zz9137qq', '99999999999999999999'])(
    'warns naming only the variable for AGENT_DAILY_TOKEN_BUDGET=%j and uses the default',
    (value) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(loadLlmConfig({ AGENT_DAILY_TOKEN_BUDGET: value }).dailyTokenBudget).toBe(200_000)
      expect(warn).toHaveBeenCalledTimes(1)
      const line = format(...warn.mock.calls[0])
      expect(line).toContain('AGENT_DAILY_TOKEN_BUDGET')
      expect(line).not.toContain(value.trim())
    },
  )

  it('reads process.env by default, afresh on every call', () => {
    vi.stubEnv('AGENT_KILL_SWITCH', '')
    expect(loadLlmConfig().killSwitch).toBe(false)
    vi.stubEnv('AGENT_KILL_SWITCH', '1')
    expect(loadLlmConfig().killSwitch).toBe(true)
  })
})
