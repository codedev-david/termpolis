import { describe, it, expect } from 'vitest'
import { extractSuggestionFromStderr } from '../../src/renderer/src/corrections/rules/extractSuggestion'
import { fixPermissionDenied } from '../../src/renderer/src/corrections/rules/permissionDenied'
import { fixCommandNotFound } from '../../src/renderer/src/corrections/rules/commandNotFound'

describe('extractSuggestion', () => {
  it('extracts git "Did you mean" suggestion', () => {
    const stderr = "git: 'comit' is not a git command. See 'git --help'.\n\nThe most similar command is\n    commit"
    expect(extractSuggestionFromStderr('git comit -m "fix"', stderr)).toBe('git commit -m "fix"')
  })

  it('extracts npm "Did you mean" suggestion', () => {
    const stderr = "Unknown command: \"instal\"\n\nDid you mean this?\n  install"
    expect(extractSuggestionFromStderr('npm instal express', stderr)).toBe('npm install express')
  })

  it('returns null for unrecognized output', () => {
    expect(extractSuggestionFromStderr('foo', 'some random error')).toBeNull()
  })
})

describe('fixPermissionDenied', () => {
  it('prepends sudo for permission denied errors', () => {
    const stderr = 'E: Could not open lock file - open (13: Permission denied)'
    expect(fixPermissionDenied('apt install vim', stderr)).toBe('sudo apt install vim')
  })

  it('does not prepend sudo if already present', () => {
    const stderr = 'Permission denied'
    expect(fixPermissionDenied('sudo apt install vim', stderr)).toBeNull()
  })

  it('returns null for non-permission errors', () => {
    expect(fixPermissionDenied('ls', 'file not found')).toBeNull()
  })
})

describe('fixCommandNotFound', () => {
  it('suggests closest command for typo', () => {
    const commands = ['docker', 'node', 'npm', 'git']
    const result = fixCommandNotFound('dockr ps', 'bash: dockr: command not found', commands)
    expect(result).toBe('docker ps')
  })

  it('returns null when no close match', () => {
    const commands = ['docker', 'node']
    const result = fixCommandNotFound('xyzabc', 'command not found', commands)
    expect(result).toBeNull()
  })

  it('returns null when stderr does not indicate command not found', () => {
    const commands = ['docker']
    const result = fixCommandNotFound('docker ps', 'some other error', commands)
    expect(result).toBeNull()
  })
})
