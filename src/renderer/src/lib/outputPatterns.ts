/**
 * Combined regex patterns for output processing.
 * Using single combined patterns instead of testing 11+ individual regexes.
 */

// Combined context limit patterns (single regex instead of 9 separate ones)
export const CONTEXT_LIMIT_PATTERN = /context (?:window |limit|is full)|token limit|maximum context|conversation is too long|out of context|session limit|exceeded.*token|too many tokens/i

// Claude Code's live "compacting" indicator — it's summarizing the conversation to
// fit the context window (the detail it drops still lives in our memory brain, so we
// re-prime afterward). Matches "Compacting conversation", "compacted the context", etc.
export const COMPACTION_PATTERN = /compact(?:ing|ed)\s+(?:the\s+)?(?:conversation|context)/i

// Combined error patterns for command fix detection (single regex instead of 6)
export const ERROR_PATTERN = /command not found|not recognized|is not a .* command|Permission denied|EACCES|No such file or directory/i

// Diff detection
export const DIFF_PATTERN = /^diff --git /m
