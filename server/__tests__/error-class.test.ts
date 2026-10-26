import { describe, expect, it } from 'vitest'
import { errorClass } from '../error-class.ts'

class FooError extends Error {}

describe('errorClass', () => {
  it('names an Error by its class', () => {
    expect(errorClass(new Error('boom'))).toBe('Error')
  })

  it('names a subclass by its own class', () => {
    expect(errorClass(new TypeError('boom'))).toBe('TypeError')
    expect(errorClass(new FooError('boom'))).toBe('FooError')
  })

  it.each([
    ['a string', 'secret', 'string'],
    ['undefined', undefined, 'undefined'],
    ['null', null, 'object'],
    ['a plain object', { message: 'secret' }, 'object'],
  ])('names %s by its typeof', (_label, thrown, expected) => {
    expect(errorClass(thrown)).toBe(expected)
  })

  it('never carries the message', () => {
    const named = errorClass(new Error('secret'))
    expect(named).toBe('Error')
    expect(named).not.toContain('secret')
  })
})
