import { describe, it, expect } from 'vitest'
import { detectDismissChar, dismissReply, isAwaitingAnswer, replyToScreen, screenKey, tailSlice } from '../../src/renderer/src/lib/promptAutoDismiss'

// The user connected the agents and this folder is neither home nor a drive root.
const CLAUDE = { agentName: 'Claude Code', allowFolderTrust: true }
const CODEX = { agentName: 'OpenAI Codex', allowFolderTrust: true }
const GEMINI = { agentName: 'Gemini CLI', allowFolderTrust: true }

// Codex 0.153.4's trust screen, as its TUI draws it.
const CODEX_TRUST = (rows: string, footer = 'Press enter to continue') =>
  '> You are in /home/u/repo\n\n'
  + 'Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection. '
  + 'Trusting the directory allows project-local config, hooks, and exec policies to load.\n\n'
  + rows + '\n\n' + footer

// Gemini CLI's trust dialog: a radio list with ● on the selected row.
const GEMINI_TRUST = (selected: number) => 'Do you trust this folder?\n'
  + 'Trusting a folder allows Gemini to execute commands it suggests.\n'
  + ['Trust folder (repo)', 'Trust parent folder (src)', "Don't trust (esc)"]
    .map((label, i) => `${i === selected ? '●' : '○'} ${i + 1}. ${label}`).join('\n')

describe('promptAutoDismiss.detectDismissChar', () => {
  describe('folder trust, when Termpolis may answer it', () => {
    it('dismisses Claude folder-trust with Enter when the cursor is already on Yes', () => {
      const tail = 'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit'
      expect(detectDismissChar(tail, CLAUDE)).toBe('\r')
    })

    it('answers Codex 0.153.4 "Do you trust the contents of this directory?"', () => {
      expect(detectDismissChar(CODEX_TRUST('› 1. Yes, continue\n  2. No, quit'), CODEX)).toBe('\r')
    })

    it('walks the Codex cursor back up to "Yes, continue"', () => {
      expect(detectDismissChar(CODEX_TRUST('  1. Yes, continue\n› 2. No, quit'), CODEX)).toBe('\x1b[A\r')
    })

    // Claude Code 2.1.x builds this dialog with `cancelFirst: true`,
    // `focus: "cancel"` and `hideIndexes: true`: "No, exit" is rendered FIRST
    // with the cursor already on it. The bare Enter this used to send therefore
    // answered "No, exit" and quit Claude the instant it started — which is what
    // made an auto-launch look like the injected command had been cut off.
    it('arrows onto "Yes" before Enter when Claude opens focused on "No, exit"', () => {
      const tail = 'Do you trust the files in this folder?\nC:/repo\n\n❯ No, exit\n  Yes, I trust this folder'
      expect(detectDismissChar(tail, CLAUDE)).toBe('\x1b[B\r')
    })

    it('arrows UP when the affirmative row sits above the cursor', () => {
      const tail = 'Do you trust the files in this folder?\n  Yes, I trust this folder\n❯ No, exit'
      expect(detectDismissChar(tail, CLAUDE)).toBe('\x1b[A\r')
    })

    it('reads the LAST rendered frame, not a stale one still in the buffer', () => {
      // Ink redraws the whole dialog on every keystroke.
      const frame = (cursor: number) =>
        'Do you trust the files in this folder?\n'
        + (cursor === 0 ? '❯ No, exit\n  Yes, I trust this folder' : '  No, exit\n❯ Yes, I trust this folder')
      expect(detectDismissChar(frame(0) + '\n' + frame(1), CLAUDE)).toBe('\r')
    })

    it('reads options out of a box-drawn dialog frame', () => {
      const tail = '│ Do you trust the files in this folder?          │\n│ ❯ No, exit                                     │\n│   Yes, I trust this folder                     │\n╰────────────────────────────────────────────────╯\n  Enter to confirm · Esc to exit'
      expect(detectDismissChar(tail, CLAUDE)).toBe('\x1b[B\r')
    })

    // No rendered options means we cannot tell which row the cursor is on, and a
    // guess costs the whole session. Trust is seeded in Claude's own config before
    // launch (src/main/claudeTrust.ts), so answering nothing here is free.
    it('answers NOTHING when the option rows cannot be read', () => {
      expect(detectDismissChar('Trust this folder and its dependencies?', CLAUDE)).toBeNull()
      expect(detectDismissChar('Do you trust the authors of this workspace?', CLAUDE)).toBeNull()
      expect(detectDismissChar('Do you trust the files in this folder?\n  Yes, proceed\n  No, exit', CLAUDE)).toBeNull()
    })

    it('answers NOTHING when no row trusts the folder', () => {
      expect(detectDismissChar("Do you trust this folder?\n● Don't trust (esc)", GEMINI)).toBeNull()
    })

    it('never lets a numbered row fall through to another pattern', () => {
      const tail = 'Do you trust the files in this folder?\n❯ 1. No, exit\n  2. Yes, I trust this folder'
      expect(detectDismissChar(tail, CLAUDE)).toBe('\x1b[B\r')
    })

    it('picks Gemini "Trust folder", never "Trust parent folder"', () => {
      expect(detectDismissChar(GEMINI_TRUST(0), GEMINI)).toBe('\r')
      expect(detectDismissChar(GEMINI_TRUST(1), GEMINI)).toBe('\x1b[A\r')
      expect(detectDismissChar(GEMINI_TRUST(2), GEMINI)).toBe('\x1b[A\x1b[A\r')
    })

    it('works whatever the terminal is called', () => {
      const tail = 'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit'
      expect(detectDismissChar(tail, { agentName: 'backend', allowFolderTrust: true })).toBe('\r')
    })
  })

  describe('folder trust that stays with the user', () => {
    const claudeTrust = 'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit'

    it('answers nothing unless the caller says Termpolis may', () => {
      expect(detectDismissChar(claudeTrust, { agentName: 'Claude Code' })).toBeNull()
      expect(detectDismissChar(claudeTrust, { agentName: 'Claude Code', allowFolderTrust: false })).toBeNull()
      expect(detectDismissChar(CODEX_TRUST('› 1. Yes, continue\n  2. No, quit'), { agentName: 'OpenAI Codex' })).toBeNull()
      expect(detectDismissChar(GEMINI_TRUST(0), { agentName: 'Gemini CLI' })).toBeNull()
    })

    it('never lets the "Press enter to continue" footer answer a trust screen', () => {
      const tail = CODEX_TRUST('› 1. Yes, continue\n  2. No, quit')
      expect(detectDismissChar(tail, { agentName: 'OpenAI Codex' })).toBeNull()
      expect(detectDismissChar('Do you trust the files in this folder? Press Enter to continue.', CODEX)).toBeNull()
    })

    it('leaves it alone when Enter would also create a sandbox (Codex on Windows)', () => {
      const tail = CODEX_TRUST('› 1. Yes, continue\n  2. No, quit', 'Press enter to continue and create a sandbox...')
      expect(detectDismissChar(tail, CODEX)).toBeNull()
    })

    it('leaves it alone when the folder brings its own permissions', () => {
      const tail = 'Do you trust the files in this folder?\n❯ No, continue without these permissions\n  Yes, I trust this folder'
      expect(detectDismissChar(tail, CLAUDE)).toBeNull()
    })

    it('ignores a dialog that is already history', () => {
      const answered = claudeTrust + '\n' + ['Welcome to Claude Code', 'cwd: C:/repo', 'Tips:', '1. Ask', '2. Edit'].join('\n')
      expect(detectDismissChar(answered, CLAUDE)).toBeNull()
    })

    it('ignores a dialog with the session prompt drawn below it', () => {
      expect(detectDismissChar(claudeTrust + '\n╭────╮\n│ > │\n╰────╯', CLAUDE)).toBeNull()
    })

    it('ignores a frame a partial redraw has moved the cursor away from', () => {
      expect(detectDismissChar('Do you trust the files in this folder?\n❯ No, exit\n  Yes, I trust this folder\n❯', CLAUDE)).toBeNull()
    })
  })

  describe('approvals and permissions are never answered', () => {
    const splash = 'Claude Code may make mistakes. Press Enter to continue.\n'
    it.each([
      ['Claude Code bash permission', 'Bash command\n  rm -rf build\n\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don\'t ask again for rm commands in C:\\repo\n  3. No, and tell Claude what to do differently (esc)'],
      ['Claude Code edit', 'Do you want to make this edit to index.ts?\n❯ 1. Yes\n  2. Yes, allow all edits during this session (shift+tab)\n  3. No'],
      ['Claude Code new file', 'Do you want to create notes.md?\n❯ 1. Yes'],
      ['Claude Code fetch', 'Do you want to allow Claude to fetch this content?\n❯ 1. Yes'],
      ['Claude Code plan mode', 'Would you like to proceed?\n❯ 1. Yes, and auto-accept edits\n  2. Yes, and manually approve edits'],
      ['Claude Code bypass-permissions warning', 'WARNING: Claude Code running in Bypass Permissions mode\n❯ 1. No, exit\n  2. Yes, I accept'],
      ['Claude Code terminal setup', "Use Claude Code's terminal setup?\n❯ 1. Yes, use recommended settings\n  2. No, maybe later with /terminal-setup"],
      ['Claude Code API key', 'Detected a custom API key in your environment\nDo you want to use this API key?\n❯ 1. No (recommended)\n  2. Yes'],
      ['Codex command', 'Would you like to run the following command?\n\n  $ git push\n\n› 1. Yes, proceed\n  2. Yes, and don\'t ask again for this command in this session\n  3. No, and tell Codex what to do differently'],
      ['Codex edits', 'Would you like to make the following edits?\n› 1. Yes, proceed'],
      ['Codex permissions', 'Would you like to grant these permissions?\n› 1. Yes, grant these permissions for this turn'],
      ['Codex apply', 'Allow Codex to apply proposed code changes?\n› 1. Yes'],
      ['Gemini tool call', "Allow execution of: 'npm'?\n● 1. Yes, allow once\n○ 2. Yes, allow always ...\n○ 3. No, suggest changes (esc)"],
      ['Gemini edit', 'Apply this change?\n● 1. Yes, allow once'],
      ['a project .mcp.json server', 'New MCP server found in .mcp.json: evil\n❯ 1. Use this and all future MCP servers in this project\n  2. Use this MCP server\n  3. Continue without using this MCP server'],
      ['"enable these MCP servers"', 'Do you want to enable these MCP servers for this session?\n1. Yes'],
      ['"configured but not trusted"', 'The following MCP servers are configured but not trusted:\n  termpolis'],
      ['"Approve MCP server"', 'Approve MCP server "termpolis"?'],
      ['"Trust the MCP server"', 'Trust the MCP server termpolis to execute tools?'],
      ['"Enable MCP server"', 'Enable MCP server termpolis for this session?'],
      ['"Use this MCP server"', 'Use this MCP server (termpolis) for the session?'],
      ['an MCP prompt behind cursor escapes', '\x1b[2J\x1b[H\x1b[1mEnable MCP server termpolis?\x1b[0m'],
      ['a request that needs approval', 'This action requires approval.'],
      ['[Y/n]', 'Install additional tools? [Y/n]'],
      ['(Y/n)', 'Continue? (Y/n)'],
      ['[y/N]', 'Overwrite existing file? [y/N]'],
    ])('%s — even under a stale splash, with trust allowed', (_label, prompt) => {
      for (const agentName of ['Claude Code', 'OpenAI Codex', 'Gemini CLI']) {
        expect(detectDismissChar(prompt, { agentName, allowFolderTrust: true })).toBeNull()
        expect(detectDismissChar(splash + prompt, { agentName, allowFolderTrust: true })).toBeNull()
      }
    })

    it('lets an approval win over a trust dialog in the same tail', () => {
      const tail = 'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit\nDo you want to proceed?'
      expect(detectDismissChar(tail, CLAUDE)).toBeNull()
    })

    it('lets an approval win over a stale onboarding heading', () => {
      expect(detectDismissChar('Choose a color theme:\n❯ 1. Dark\nDo you want to proceed?\n❯ 1. Yes', CLAUDE)).toBeNull()
    })

    it('never answers any other numbered choice', () => {
      expect(detectDismissChar('Pick an option below\n❯ 1. Continue\n  2. Exit', CLAUDE)).toBeNull()
      expect(detectDismissChar('Please select an option:\n1) Continue\n2) Exit', CODEX)).toBeNull()
      expect(detectDismissChar('Type 1 to approve, 2 to deny', CODEX)).toBeNull()
      expect(detectDismissChar('Please select an option for exporting', CLAUDE)).toBeNull()
    })
  })

  describe('onboarding / "press enter to continue" splash', () => {
    it('dismisses "Press Enter to continue"', () => {
      const tail = 'Claude Code may make mistakes. Press Enter to continue.'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('dismisses "Press Return to proceed"', () => {
      const tail = 'Welcome! Press Return to proceed.'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('dismisses "press any key to continue"', () => {
      const tail = 'Setup complete. press any key to continue'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('dismisses "Hit Enter to continue", whatever the terminal is called', () => {
      expect(detectDismissChar('Hit Enter to continue', { agentName: '' })).toBe('\r')
    })

    it('never answers "continue and <something>"', () => {
      expect(detectDismissChar('Press enter to continue and create a sandbox...', CODEX)).toBeNull()
      expect(detectDismissChar('Hit Enter to continue with setup', CLAUDE)).toBeNull()
    })

    it('leaves a splash alone while a menu is on screen', () => {
      const tail = 'Sign in with ChatGPT to use Codex\n› 1. Sign in with ChatGPT\n  2. Provide your own API key\n\nPress Enter to continue'
      expect(detectDismissChar(tail, CODEX)).toBeNull()
    })

    it('leaves the phrase alone once the session is live', () => {
      expect(detectDismissChar('● Done. Press Enter to continue.', CLAUDE)).toBeNull()
      expect(detectDismissChar('⏺ Done. Press Enter to continue.', CLAUDE)).toBeNull()
      expect(detectDismissChar('Press Enter to continue.\n╭────╮\n│ > │\n╰────╯', CLAUDE)).toBeNull()
    })

    it('ignores a splash that has scrolled up the buffer', () => {
      const tail = 'Press Enter to continue\n' + Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\n')
      expect(detectDismissChar(tail, CLAUDE)).toBeNull()
    })

    it('reads words a TUI placed by cursor position', () => {
      expect(detectDismissChar('\x1b[12;1HPress\x1b[12;7Henter\x1b[12;13Hto\x1b[12;16Hcontinue', CODEX)).toBe('\r')
      expect(detectDismissChar('Press\x1b[1Center to continue', CODEX)).toBe('\r')
    })
  })

  describe('Gemini-specific', () => {
    it('answers "accept the terms" with Enter', () => {
      const tail = 'Please accept the terms of service to continue'
      expect(detectDismissChar(tail, { agentName: 'Gemini CLI' })).toBe('\r')
    })

    it('answers "authenticate with" prompt', () => {
      const tail = 'How would you like to authenticate with Google?'
      expect(detectDismissChar(tail, { agentName: 'Gemini CLI' })).toBe('\r')
    })

    it('keeps the terms pattern to Gemini', () => {
      expect(detectDismissChar('Please accept the terms of service to continue', { agentName: 'Claude Code' })).toBeNull()
    })
  })

  describe('no-match behavior', () => {
    it('returns null for empty tail', () => {
      expect(detectDismissChar('', { agentName: 'Claude Code' })).toBeNull()
    })

    it('returns null for a tail that is only escape codes', () => {
      expect(detectDismissChar('\x1b[0m\x1b[?25l', { agentName: 'Claude Code' })).toBeNull()
    })

    it('returns null for random agent output', () => {
      const tail = 'Reading file src/main/index.ts...\nRunning tests...'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBeNull()
    })

    it('returns null for partial match that looks like a prompt but is not', () => {
      const tail = 'The user said "do you trust me" earlier, but...'
      // "do you trust the files" requires the specific suffix, this should miss
      expect(detectDismissChar(tail, CLAUDE)).toBeNull()
    })
  })

  describe('CRLF + ANSI normalization', () => {
    it('matches folder-trust through Windows CRLF line endings', () => {
      const tail = 'Do you trust the files in this folder?\r\n❯ 1. Yes, proceed\r\n  2. No, exit'
      expect(detectDismissChar(tail, CLAUDE)).toBe('\r')
    })

    it('matches folder-trust through ANSI color codes', () => {
      // Real Claude Code wraps the prompt in SGR escapes — without stripping
      // these, the regex misses the question entirely.
      const tail = '\x1b[33mDo you trust the files in this folder?\x1b[0m\n\x1b[32m❯ 1. Yes\x1b[0m'
      expect(detectDismissChar(tail, CLAUDE)).toBe('\r')
    })

    it('reads rows a repaint placed by cursor position', () => {
      const tail = 'Do you trust the files in this folder?\x1b[5;1H❯ No, exit\x1b[6;1H  Yes, I trust this folder'
      expect(detectDismissChar(tail, CLAUDE)).toBe('\x1b[B\r')
    })

    it('strips OSC titles and charset switches', () => {
      const tail = '\x1b]0;claude\x07\x1b(BClaude Code may make mistakes. Press Enter to continue.'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })
  })

  describe('newer Claude Code onboarding (fresh-install variants)', () => {
    it('matches "Would you like to trust" and answers the highlighted row', () => {
      const tail = 'Would you like to trust this folder?\n❯ No, exit\n  Yes, I trust this folder'
      expect(detectDismissChar(tail, CLAUDE)).toBe('\x1b[B\r')
    })

    it('matches "Trust this workspace" and answers the highlighted row', () => {
      const tail = 'Trust this workspace and run on it?\n❯ Yes, proceed\n  No, exit'
      expect(detectDismissChar(tail, CLAUDE)).toBe('\r')
    })

    it('matches theme picker on fresh install', () => {
      const tail = 'Choose a color theme:\n❯ 1. Dark\n  2. Light'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('matches Claude Code 2.x "Choose the text style" picker', () => {
      const tail = 'Choose the text style that looks best with your terminal\n❯ 1. Dark mode ✔\n  2. Light mode'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('matches "select your style" theme picker', () => {
      const tail = 'Select your style:\n❯ Default'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('matches "How would you like to login"', () => {
      const tail = 'How would you like to login?\n❯ 1. Anthropic Console'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('matches "Select login method"', () => {
      const tail = 'Select login method:\n❯ 1. Claude account with subscription'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })

    it('matches "press Enter to begin"', () => {
      const tail = 'All set! Press Enter to begin.'
      expect(detectDismissChar(tail, { agentName: 'Claude Code' })).toBe('\r')
    })
  })
})

describe('promptAutoDismiss.dismissReply', () => {
  const trust = 'Do you trust the files in this folder?\n❯ No, exit\n  Yes, I trust this folder'

  it('answers folder trust only when the user allows it here', async () => {
    expect(await dismissReply(trust, 'Claude Code', async () => true)).toBe('\x1b[B\r')
    expect(await dismissReply(trust, 'Claude Code', async () => false)).toBeNull()
  })

  it('leaves the dialog to the user when the lookup fails', async () => {
    expect(await dismissReply(trust, 'Claude Code', () => Promise.reject(new Error('ipc')))).toBeNull()
    expect(await dismissReply(trust, 'Claude Code', () => { throw new TypeError('not a function') })).toBeNull()
    expect(await dismissReply(trust, 'Claude Code', async () => 'yes' as unknown as boolean)).toBeNull()
  })

  it('does not ask when no folder-trust dialog is on screen', async () => {
    let asked = 0
    const ask = async () => { asked++; return true }
    expect(await dismissReply('Press Enter to continue', 'Claude Code', ask)).toBe('\r')
    expect(await dismissReply('Do you want to proceed?\n❯ 1. Yes', 'Claude Code', ask)).toBeNull()
    expect(await dismissReply('Running tests...', 'Claude Code', ask)).toBeNull()
    expect(asked).toBe(0)
  })
})

describe('promptAutoDismiss.replyToScreen', () => {
  const trust = 'banner\nDo you trust the files in this folder?\n❯ No, exit\n  Yes, I trust this folder'
  const allow = async () => true

  it('answers when the screen is unchanged on the second read', async () => {
    let reads = 0
    const read = async () => { reads++; return trust }
    expect(await replyToScreen(trust, 'Claude Code', allow, read)).toBe('\x1b[B\r')
    expect(reads).toBe(1)
  })

  it('stays silent when the user answered the dialog while consent was looked up', async () => {
    expect(await replyToScreen(trust, 'Claude Code', allow, async () => trust + '\n\n> fix the')).toBeNull()
  })

  it('does not read the screen again when there is nothing to answer', async () => {
    let reads = 0
    const read = async () => { reads++; return '' }
    expect(await replyToScreen('Running tests...', 'Claude Code', allow, read)).toBeNull()
    expect(await replyToScreen(trust, 'Claude Code', async () => false, read)).toBeNull()
    expect(reads).toBe(0)
  })

  it('stays silent when the screen cannot be read again', async () => {
    expect(await replyToScreen(trust, 'Claude Code', allow, async () => null)).toBeNull()
    expect(await replyToScreen(trust, 'Claude Code', allow, () => Promise.reject(new Error('ipc')))).toBeNull()
    expect(await replyToScreen(trust, 'Claude Code', allow, () => { throw new TypeError('gone') })).toBeNull()
  })

  it('judges the end of a long buffer, where only older output changed', async () => {
    const end = '\n' + '-'.repeat(250) + '\nPress Enter to continue'
    const read = async () => 'y'.repeat(5000) + end
    expect(await replyToScreen('x'.repeat(5000) + end, 'Claude Code', allow, read)).toBe('\r')
  })

  it('treats a missing buffer as an empty screen', async () => {
    expect(await replyToScreen(undefined as unknown as string, 'Claude Code', allow, async () => '')).toBeNull()
  })
})

describe('promptAutoDismiss.screenKey', () => {
  it('is the last 200 characters, or all of a shorter buffer', () => {
    expect(screenKey('abc')).toBe('abc')
    expect(screenKey('a'.repeat(300) + 'b'.repeat(200))).toBe('b'.repeat(200))
    expect(screenKey('')).toBe('')
    expect(screenKey(undefined as unknown as string)).toBe('')
  })
})

describe('promptAutoDismiss.tailSlice', () => {
  it('returns empty string for empty input', () => {
    expect(tailSlice('')).toBe('')
  })

  it('returns the whole string when shorter than the slice size', () => {
    expect(tailSlice('hello', 1500)).toBe('hello')
  })

  it('returns the last N chars when longer than size', () => {
    const big = 'x'.repeat(3000)
    expect(tailSlice(big, 500).length).toBe(500)
  })

  it('uses default size of 1500 when not provided', () => {
    const big = 'x'.repeat(2000)
    expect(tailSlice(big).length).toBe(1500)
  })
})

describe('promptAutoDismiss.isAwaitingAnswer', () => {
  it('is false for an empty tail and for an idle composer', () => {
    expect(isAwaitingAnswer('')).toBe(false)
    expect(isAwaitingAnswer('>_ OpenAI Codex (v0.153.4)\n\n› \n  ? for shortcuts')).toBe(false)
    expect(isAwaitingAnswer('╭────────╮\n│ >      │\n╰────────╯\n  ? for shortcuts')).toBe(false)
  })

  it.each([
    ['a Claude Code permission prompt', 'Bash command\n  rm -rf build\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No'],
    ['a folder-trust question', 'Do you trust the files in this folder?'],
    ['a Codex folder-trust dialog', CODEX_TRUST('› 1. Yes, continue\n  2. No, quit')],
    ['a Yes/No list whose question it does not know', 'Replace the saved layout?\n❯ 1. Yes\n  2. No'],
    ['a splash waiting for Enter', 'Claude Code may make mistakes. Press Enter to continue.\n'],
    ['a login-method picker', 'How would you like to authenticate with Google?\n● 1. Login with Google\n  2. Use Gemini API key'],
  ])('is true on %s', (_name, tail) => {
    expect(isAwaitingAnswer(tail)).toBe(true)
  })

  it('does not take one line starting with Yes or No for a dialog', () => {
    // An agent's reply, and Codex echoing a message the user typed.
    expect(isAwaitingAnswer('• Checked the config.\n\nNo changes needed.\n\n› ')).toBe(false)
    expect(isAwaitingAnswer('› yes, go ahead with the rename\n\n• Renamed 3 files.\n\n› ')).toBe(false)
  })
})
