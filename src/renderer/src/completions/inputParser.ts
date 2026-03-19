export interface ParsedInput {
  command: string
  subcommand?: string
  partial: string
  tokens: string[]
  context: 'command' | 'subcommand' | 'flag' | 'path' | 'arg'
}

export function parseInput(input: string): ParsedInput {
  const trimmed = input.trimStart()
  const tokens = trimmed.split(/\s+/).filter(Boolean)

  if (tokens.length === 0) {
    return { command: '', partial: '', tokens: [], context: 'command' }
  }

  const endsWithSpace = trimmed.endsWith(' ')
  const command = tokens[0]

  // Still typing the command name
  if (tokens.length === 1 && !endsWithSpace) {
    return { command, partial: command, tokens, context: 'command' }
  }

  const lastToken = endsWithSpace ? '' : tokens[tokens.length - 1]

  // Path detection
  if (lastToken.includes('/') || lastToken.includes('\\')) {
    return { command, partial: lastToken, tokens, context: 'path' }
  }

  // Flag detection
  if (lastToken.startsWith('-')) {
    const subcommand = tokens.length > 2 || (tokens.length === 2 && endsWithSpace)
      ? tokens[1] : undefined
    return { command, subcommand, partial: lastToken, tokens, context: 'flag' }
  }

  // Subcommand detection (second token, not a flag)
  if (tokens.length === 2 && !endsWithSpace) {
    return { command, partial: lastToken, tokens, context: 'subcommand' }
  }

  const subcommand = tokens[1]?.startsWith('-') ? undefined : tokens[1]
  return { command, subcommand, partial: lastToken, tokens, context: 'arg' }
}
