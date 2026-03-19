import { describe, it, expect } from 'vitest'
import { parseInput } from '../../src/renderer/src/completions/inputParser'

describe('parseInput', () => {
  it('parses empty input', () => {
    const result = parseInput('')
    expect(result.command).toBe('')
    expect(result.tokens).toEqual([])
    expect(result.context).toBe('command')
  })

  it('parses partial command', () => {
    const result = parseInput('gi')
    expect(result.command).toBe('gi')
    expect(result.context).toBe('command')
  })

  it('parses command with subcommand', () => {
    const result = parseInput('git com')
    expect(result.command).toBe('git')
    expect(result.partial).toBe('com')
    expect(result.context).toBe('subcommand')
  })

  it('detects flag context after dash', () => {
    const result = parseInput('git commit -')
    expect(result.command).toBe('git')
    expect(result.subcommand).toBe('commit')
    expect(result.context).toBe('flag')
  })

  it('detects flag context after double dash', () => {
    const result = parseInput('git commit --am')
    expect(result.context).toBe('flag')
    expect(result.partial).toBe('--am')
  })

  it('detects path context after slash', () => {
    const result = parseInput('cat /etc/hos')
    expect(result.context).toBe('path')
    expect(result.partial).toBe('/etc/hos')
  })
})
