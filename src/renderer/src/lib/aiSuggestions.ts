/**
 * AI Command Suggestions — detects natural language input and suggests shell commands.
 *
 * When a user types something that looks like a question or natural language
 * (not a valid command), this module provides instant local suggestions.
 * No API calls — all pattern-based for zero latency.
 */

export interface AISuggestion {
  command: string
  description: string
}

interface PatternRule {
  pattern: RegExp
  suggestions: AISuggestion[]
}

const RULES: PatternRule[] = [
  // File operations
  { pattern: /(?:find|search for|look for|locate)\s+(?:large|big)\s+files?/i, suggestions: [
    { command: 'find . -type f -size +100M', description: 'Find files larger than 100MB' },
    { command: 'du -sh * | sort -rh | head -20', description: 'Show largest items in current directory' },
  ]},
  { pattern: /(?:find|search for|look for|locate)\s+(?:files?|directories?)\s+(?:named?|called)\s+"?([^"]+)"?/i, suggestions: [
    { command: 'find . -name "*$1*"', description: 'Search by filename' },
  ]},
  { pattern: /(?:find|search|grep|look)\s+(?:for\s+)?(?:text|string|word|pattern)\s+"?([^"]+)"?/i, suggestions: [
    { command: 'grep -rn "$1" .', description: 'Search for text in all files recursively' },
    { command: 'grep -rn --include="*.ts" "$1" .', description: 'Search in TypeScript files only' },
  ]},
  { pattern: /(?:how much|check)\s+(?:disk|storage|space)/i, suggestions: [
    { command: 'df -h', description: 'Show disk space usage' },
    { command: 'du -sh *', description: 'Show directory sizes' },
  ]},
  { pattern: /(?:delete|remove|clean)\s+(?:all\s+)?node.?modules/i, suggestions: [
    { command: 'rm -rf node_modules', description: 'Delete node_modules' },
    { command: 'rm -rf node_modules && npm install', description: 'Clean reinstall' },
  ]},
  { pattern: /(?:count|how many)\s+(?:lines?|loc)\s+(?:of\s+)?(?:code)?/i, suggestions: [
    { command: 'find . -name "*.ts" -o -name "*.tsx" | xargs wc -l', description: 'Count lines in TypeScript files' },
    { command: 'git ls-files | xargs wc -l', description: 'Count lines in all tracked files' },
  ]},
  { pattern: /(?:list|show|what)\s+(?:files?|what's)\s+(?:changed|modified|different)/i, suggestions: [
    { command: 'git status', description: 'Show changed files' },
    { command: 'git diff --stat', description: 'Show changed files with stats' },
  ]},

  // Process management
  { pattern: /(?:what's|what is|show)\s+(?:running|using)\s+(?:port|on port)\s+(\d+)/i, suggestions: [
    { command: 'lsof -i :$1', description: 'Show process on port (macOS/Linux)' },
    { command: 'netstat -ano | findstr :$1', description: 'Show process on port (Windows)' },
  ]},
  { pattern: /(?:kill|stop)\s+(?:process|everything)\s+(?:on\s+)?(?:port\s+)?(\d+)/i, suggestions: [
    { command: 'kill $(lsof -t -i:$1)', description: 'Kill process on port (macOS/Linux)' },
    { command: 'npx kill-port $1', description: 'Kill port (cross-platform)' },
  ]},
  { pattern: /(?:show|list|what)\s+(?:processes?|running)/i, suggestions: [
    { command: 'ps aux | head -20', description: 'Show running processes' },
    { command: 'top', description: 'Interactive process monitor' },
  ]},

  // Git operations
  { pattern: /(?:undo|revert)\s+(?:last|my last)\s+commit/i, suggestions: [
    { command: 'git reset --soft HEAD~1', description: 'Undo last commit, keep changes staged' },
    { command: 'git reset HEAD~1', description: 'Undo last commit, unstage changes' },
  ]},
  { pattern: /(?:show|view|see)\s+(?:git\s+)?(?:log|history|commits?)/i, suggestions: [
    { command: 'git log --oneline -20', description: 'Show recent commits' },
    { command: 'git log --oneline --graph --all', description: 'Show commit graph' },
  ]},
  { pattern: /(?:create|new|make)\s+(?:a\s+)?(?:git\s+)?branch\s+(?:called\s+|named\s+)?"?([^\s"]+)"?/i, suggestions: [
    { command: 'git checkout -b $1', description: 'Create and switch to new branch' },
  ]},
  { pattern: /(?:switch|change|checkout)\s+(?:to\s+)?(?:branch\s+)?"?([^\s"]+)"?/i, suggestions: [
    { command: 'git checkout $1', description: 'Switch to branch' },
  ]},
  { pattern: /(?:what|which)\s+branch\s+(?:am i|are we)\s+on/i, suggestions: [
    { command: 'git branch --show-current', description: 'Show current branch' },
  ]},
  { pattern: /(?:stash|save)\s+(?:my\s+)?(?:changes|work)/i, suggestions: [
    { command: 'git stash', description: 'Stash current changes' },
    { command: 'git stash push -m "WIP"', description: 'Stash with message' },
  ]},

  // npm/package management
  { pattern: /(?:install|add)\s+(?:package|dependency)\s+"?([^\s"]+)"?/i, suggestions: [
    { command: 'npm install $1', description: 'Install as dependency' },
    { command: 'npm install -D $1', description: 'Install as dev dependency' },
  ]},
  { pattern: /(?:what|which|show|list)\s+(?:packages?|dependencies)\s+(?:are\s+)?(?:outdated|old)/i, suggestions: [
    { command: 'npm outdated', description: 'List outdated packages' },
  ]},
  { pattern: /(?:run|start)\s+(?:the\s+)?(?:dev|development)\s+server/i, suggestions: [
    { command: 'npm run dev', description: 'Start dev server' },
  ]},
  { pattern: /(?:run|execute)\s+(?:the\s+)?tests?/i, suggestions: [
    { command: 'npm test', description: 'Run tests' },
    { command: 'npm run test:coverage', description: 'Run tests with coverage' },
  ]},

  // System info
  { pattern: /(?:what|show)\s+(?:is\s+)?(?:my\s+)?(?:ip|ip address)/i, suggestions: [
    { command: 'curl -s ifconfig.me', description: 'Show public IP' },
    { command: 'hostname -I', description: 'Show local IPs (Linux)' },
  ]},
  { pattern: /(?:how much|check|show)\s+(?:memory|ram)/i, suggestions: [
    { command: 'free -h', description: 'Show memory usage (Linux)' },
    { command: 'vm_stat', description: 'Show memory usage (macOS)' },
  ]},

  // Docker
  { pattern: /(?:list|show)\s+(?:docker\s+)?containers?/i, suggestions: [
    { command: 'docker ps', description: 'Show running containers' },
    { command: 'docker ps -a', description: 'Show all containers (including stopped)' },
  ]},
  { pattern: /(?:stop|kill)\s+all\s+(?:docker\s+)?containers?/i, suggestions: [
    { command: 'docker stop $(docker ps -q)', description: 'Stop all running containers' },
  ]},

  // Misc
  { pattern: /(?:what|show)\s+(?:time|date)\s+(?:is\s+)?(?:it)?/i, suggestions: [
    { command: 'date', description: 'Show current date and time' },
  ]},
  { pattern: /(?:make|create)\s+(?:a\s+)?(?:new\s+)?(?:directory|folder)\s+(?:called\s+|named\s+)?"?([^\s"]+)"?/i, suggestions: [
    { command: 'mkdir -p $1', description: 'Create directory' },
  ]},
  { pattern: /(?:download|fetch|get)\s+(?:a\s+)?(?:file\s+)?(?:from\s+)?"?(https?:\/\/[^\s"]+)"?/i, suggestions: [
    { command: 'curl -O "$1"', description: 'Download file' },
    { command: 'wget "$1"', description: 'Download file with wget' },
  ]},
  { pattern: /(?:compress|zip)\s+(?:this\s+)?(?:folder|directory)/i, suggestions: [
    { command: 'tar -czf archive.tar.gz .', description: 'Compress current directory' },
    { command: 'zip -r archive.zip .', description: 'Zip current directory' },
  ]},
]

/**
 * Check if input looks like natural language (not a shell command).
 */
export function isNaturalLanguage(input: string): boolean {
  const trimmed = input.trim()
  if (trimmed.length < 5) return false
  // Starts with a question word
  if (/^(how|what|which|where|when|why|who|can|could|show|list|find|search|create|make|delete|remove|undo|revert|stop|kill|run|install|check|count)\b/i.test(trimmed)) return true
  // Contains question mark
  if (trimmed.endsWith('?')) return true
  // Contains common natural language connectors
  if (/\b(the|my|all|for|to|is|in|on|with|from|that|this)\b/i.test(trimmed) && trimmed.split(' ').length >= 3) return true
  return false
}

/**
 * Get command suggestions for natural language input.
 * Returns matching suggestions with $1, $2 etc. replaced by captured groups.
 */
export function getSuggestions(input: string): AISuggestion[] {
  const trimmed = input.trim()
  if (!trimmed) return []

  for (const rule of RULES) {
    const match = trimmed.match(rule.pattern)
    if (match) {
      return rule.suggestions.map(s => ({
        command: s.command.replace(/\$(\d+)/g, (_, n) => match[parseInt(n)] || ''),
        description: s.description,
      }))
    }
  }

  return []
}
