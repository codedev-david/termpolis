import { describe, it, expect } from 'vitest'
import { isNaturalLanguage, getSuggestions } from '../../src/renderer/src/lib/aiSuggestions'

describe('isNaturalLanguage', () => {
  it('returns false for short input', () => {
    expect(isNaturalLanguage('ls')).toBe(false)
    expect(isNaturalLanguage('cd')).toBe(false)
    expect(isNaturalLanguage('')).toBe(false)
  })

  it('detects question words', () => {
    expect(isNaturalLanguage('how do I find large files')).toBe(true)
    expect(isNaturalLanguage('what is running on port 3000')).toBe(true)
    expect(isNaturalLanguage('show me the git log')).toBe(true)
    expect(isNaturalLanguage('find files named test')).toBe(true)
    expect(isNaturalLanguage('list all containers')).toBe(true)
    expect(isNaturalLanguage('create a new branch called feature')).toBe(true)
    expect(isNaturalLanguage('delete all node_modules')).toBe(true)
    expect(isNaturalLanguage('count lines of code')).toBe(true)
    expect(isNaturalLanguage('check disk space')).toBe(true)
    expect(isNaturalLanguage('run the tests')).toBe(true)
    expect(isNaturalLanguage('install package express')).toBe(true)
  })

  it('detects questions ending with ?', () => {
    expect(isNaturalLanguage('which branch am I on?')).toBe(true)
    expect(isNaturalLanguage('what port is it on?')).toBe(true)
  })

  it('detects natural language connectors', () => {
    expect(isNaturalLanguage('all the files in this directory')).toBe(true)
    expect(isNaturalLanguage('save my changes to the branch')).toBe(true)
  })

  it('returns false for actual commands', () => {
    expect(isNaturalLanguage('git status')).toBe(false)
    expect(isNaturalLanguage('npm install')).toBe(false)
    expect(isNaturalLanguage('docker ps -a')).toBe(false)
  })
})

describe('getSuggestions', () => {
  it('returns empty for non-matching input', () => {
    expect(getSuggestions('')).toEqual([])
    expect(getSuggestions('hello world')).toEqual([])
  })

  it('suggests find commands for large files', () => {
    const results = getSuggestions('find large files')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('find')
    expect(results[0].description).toBeTruthy()
  })

  it('suggests grep for text search', () => {
    const results = getSuggestions('search for text "TODO"')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('grep')
    expect(results[0].command).toContain('TODO')
  })

  it('substitutes captured groups into commands', () => {
    const results = getSuggestions('find files named "config.json"')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('config.json')
  })

  it('suggests git reset for undo commit', () => {
    const results = getSuggestions('undo last commit')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('git reset')
  })

  it('suggests git log for history', () => {
    const results = getSuggestions('show git history')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('git log')
  })

  it('suggests branch creation', () => {
    const results = getSuggestions('create branch called feature-auth')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('feature-auth')
  })

  it('suggests npm install for packages', () => {
    const results = getSuggestions('install package lodash')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('npm install')
    expect(results[0].command).toContain('lodash')
  })

  it('suggests npm test for running tests', () => {
    const results = getSuggestions('run the tests')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('npm test')
  })

  it('suggests disk space commands', () => {
    const results = getSuggestions('check disk space')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('df')
  })

  it('suggests port commands', () => {
    const results = getSuggestions("what's running on port 8080")
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('8080')
  })

  it('suggests kill port commands', () => {
    const results = getSuggestions('kill process on port 3000')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('3000')
  })

  it('suggests git stash', () => {
    const results = getSuggestions('stash my changes')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('git stash')
  })

  it('suggests docker commands', () => {
    const results = getSuggestions('list docker containers')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('docker ps')
  })

  it('suggests npm outdated', () => {
    const results = getSuggestions('what packages are outdated')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('npm outdated')
  })

  it('suggests git status for changed files', () => {
    const results = getSuggestions('show files changed')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('git')
  })

  it('suggests mkdir', () => {
    const results = getSuggestions('make a directory called components')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('mkdir')
    expect(results[0].command).toContain('components')
  })

  it('suggests curl for downloads', () => {
    const results = getSuggestions('download file from https://example.com/file.zip')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('curl')
    expect(results[0].command).toContain('example.com')
  })

  it('suggests dev server start', () => {
    const results = getSuggestions('run the dev server')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('npm run dev')
  })

  it('suggests node_modules cleanup', () => {
    const results = getSuggestions('delete node_modules')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('rm -rf node_modules')
  })

  it('suggests line count', () => {
    const results = getSuggestions('count lines of code')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('wc -l')
  })

  it('suggests compression', () => {
    const results = getSuggestions('compress this folder')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].command).toContain('tar')
  })
})
