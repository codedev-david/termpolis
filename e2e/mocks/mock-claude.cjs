#!/usr/bin/env node
'use strict';

/**
 * Mock Claude Code binary used by E2E tests.
 *
 * Three modes:
 *   1. `--version`               → print a version banner and exit 0
 *   2. `-p` / `-p "<prompt>"`    → run as the Swarm Conductor: drive MCP tools
 *                                  to create tasks, spawn agent terminals, mark
 *                                  them complete, and signal SWARM COMPLETE.
 *                                  With no value after -p the prompt is read
 *                                  from stdin, which is how Termpolis launches
 *                                  the conductor (GitHub #36).
 *   3. (no recognized args)      → interactive stub used by swarm-integration
 *                                  (trust prompt + `I'll help with: X` echoes).
 *      With `--model <alias>`, which STEP 4 lets a conductor add, the stub is a
 *      Claude Code already past that dialog: at its input box, which
 *      write_to_terminal's submit waits for, types into, and sends with Enter.
 *
 * In mode 2, MOCK_CLAUDE_RECORD=<file> writes the argv and prompt received there
 * as JSON, so a spec can check what the conductor was actually handed.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const argv = process.argv.slice(2);

// --- Mode 1: --version ---
if (argv.includes('--version')) {
  console.log('1.0.0 (Claude Code mock for E2E)');
  process.exit(0);
}

// --- Mode 2: -p [prompt] (smart conductor) ---
const pIdx = argv.indexOf('-p');
if (pIdx !== -1) {
  // Like the real CLI, an option it doesn't know ends the run before anything
  // happens. That is what a prompt cut up on the command line did to the
  // conductor on Windows (GitHub #36): a piece such as `--watch …` arrived as
  // an option, and claude exited with "error: unknown option".
  const unknown = unknownOption(argv);
  if (unknown) {
    console.error(`error: unknown option '${unknown}'`);
    process.exit(1);
  }
  readPrompt(argv, pIdx)
    .then((prompt) => {
      if (process.env.MOCK_CLAUDE_RECORD) {
        fs.writeFileSync(process.env.MOCK_CLAUDE_RECORD, JSON.stringify({ argv, prompt }));
      }
      if (!prompt) {
        console.error('Error: Input must be provided either through stdin or as a prompt argument when using --print');
        process.exit(1);
      }
      // MOCK_CLAUDE_BYPASS_MCP=1 simulates the v1.11.5 production failure mode:
      // Claude Code runs the conductor prompt but its MCP registration failed
      // (because ~/.mcp.json points at a missing adapter file), so the conductor
      // answers directly without calling any MCP tools. We print the exact
      // "swarm MCP tools weren't available" message that real Claude Code
      // emitted in the production bug, then exit 0 — the renderer's
      // conductorManager monitoring loop should detect this and surface an
      // error notification to the user.
      if (process.env.MOCK_CLAUDE_BYPASS_MCP === '1') {
        console.log('[Mock Conductor] BYPASS mode — simulating MCP-unavailable path');
        console.log('');
        // Pick the phrasing based on the variant env — `1` uses the v1.11.5
        // original phrasing, `v2` uses the v1.11.6 phrasing observed in prod
        // (same root cause, different words). The regex in conductorManager
        // must catch both.
        if (process.env.MOCK_CLAUDE_BYPASS_PHRASING === 'v2') {
          console.log("Note: the orchestration MCP tools (`swarm_send_message`, `swarm_create_task`, `create_terminal`, etc.) aren't registered in this session, so I built the SPA directly rather than sitting idle.");
        } else {
          console.log("Note: swarm MCP tools weren't available in this session, so I built it directly rather than orchestrating multiple agents.");
        }
        console.log('');
        console.log('I have completed the task. No further swarm coordination required.');
        process.exit(0);
      }
      return runConductor(prompt);
    })
    .catch((err) => {
      console.error('[Mock Conductor] fatal:', err && err.stack ? err.stack : err);
      process.exit(1);
    });
} else {
  runInteractive();
}

// The options the conductor launch can pass, each with how many values it takes.
// -p takes the prompt as its value only when one follows; otherwise it's on stdin.
function unknownOption(args) {
  const values = { '--mcp-config': 1, '--model': 1, '--output-format': 1 };
  const flags = new Set(['-p', '--print', '--dangerously-skip-permissions', '--verbose']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (values[a]) { i += values[a]; continue; }
    if (flags.has(a)) continue;
    if (a.startsWith('-')) return a;
  }
  return null;
}

function readPrompt(args, at) {
  const next = args[at + 1];
  if (next !== undefined && !next.startsWith('-')) return Promise.resolve(next);
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Interactive stub (preserves existing swarm-integration.spec.ts behavior)
// ───────────────────────────────────────────────────────────────────────────
function runInteractive() {
  if (argv.includes('--model')) return runAtInputBox();
  const readline = require('readline');

  // The workspace-trust dialog, rendered the way Claude Code 2.1.x renders it:
  // `cancelFirst: true, focus: "cancel"` puts "No, exit" FIRST with the cursor
  // already on it, and `hideIndexes: true` drops the "1." / "2." numbering. So a
  // blind Enter QUITS. That is the whole bug, and the mock has to reproduce it —
  // the caller must arrow onto the affirmative row before confirming.
  const TRUST_OPTIONS = ['No, exit', 'Yes, I trust this folder'];
  let trustCursor = 0;
  console.log('Do you trust the files in this folder?');
  console.log(process.cwd());
  console.log('');
  TRUST_OPTIONS.forEach((label, i) => console.log((i === trustCursor ? '❯ ' : '  ') + label));

  // Read the dialog in RAW mode, the way a real Ink app does. Cooked mode cannot
  // work here: on Windows the ConPTY console keeps its own line editor, which
  // CONSUMES arrow keys (they move its cursor and never reach the child), so a
  // readline-based reader can never see the Down that answers this dialog.
  const stdin = process.stdin;
  if (stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('end', () => process.exit(0));

  const onKeys = (buf) => {
    const s = buf.toString('utf8');
    if (s.includes('\x03')) process.exit(0); // Ctrl+C
    const downs = (s.match(/\x1b(?:\[|O)B/g) || []).length;
    const ups = (s.match(/\x1b(?:\[|O)A/g) || []).length;
    trustCursor = Math.max(0, Math.min(TRUST_OPTIONS.length - 1, trustCursor + downs - ups));
    // A select reads KEYS. A bracketed paste — Termpolis pastes its memory primer
    // into agent terminals — goes into the app's text buffer and confirms NOTHING,
    // even though ConPTY hands it over with a newline attached. So a chunk that
    // still carries text once the arrows are stripped is a paste: never a confirm.
    const text = s.replace(/\x1b(?:\[|O)[A-D]/g, '').replace(/[^ -~]/g, '').trim();
    if (text) return;
    if (!/[\r\n]/.test(s)) return; // arrows only so far — keep waiting for Enter
    if (!/^yes\b/i.test(TRUST_OPTIONS[trustCursor])) {
      console.log('Exiting.');
      process.exit(0);
    }
    stdin.removeListener('data', onKeys);
    if (stdin.setRawMode) stdin.setRawMode(false);
    startSession();
  };
  stdin.on('data', onKeys);

  function startSession() {
    console.log('Claude Code v1.0.0 (mock)');
    console.log('Model: claude-opus-4-6');
    process.stdout.write('claude> ');

    const rl = readline.createInterface({ input: stdin, output: process.stdout, terminal: false });
    rl.on('close', () => process.exit(0));
    rl.on('line', (input) => {
      const trimmed = input.trim();
      if (trimmed === 'exit' || trimmed === '/exit') process.exit(0);
      if (trimmed.includes('swarm') || trimmed.includes('Your role')) {
        console.log('Working on assigned task...');
        console.log('Claude Code processing...');
      } else {
        console.log(`I'll help with: ${trimmed}`);
      }
      process.stdout.write('claude> ');
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// A Claude Code at its input box, for write_to_terminal's submit (GitHub #36)
// ───────────────────────────────────────────────────────────────────────────
// Drawn the way the status detector reads Claude Code's screen: a rule, then `❯ `
// with what is typed after it. Enter sends what was typed: the stub is busy for a
// moment ("esc to interrupt", as Claude Code's footer says while it works), then
// prints what it took and draws its box again. A paste is no keystroke, as in the
// trust stub above, and an Enter in an empty box does nothing.
function runAtInputBox() {
  const RULE = '─'.repeat(60);
  const out = (s) => process.stdout.write(s);
  const drawBox = () => out(`${RULE}\r\n❯ `);
  out('Claude Code v1.0.0 (mock)\r\n\r\n');
  drawBox();

  const stdin = process.stdin;
  if (stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('end', () => process.exit(0));
  let typed = '';
  let busy = false;
  stdin.on('data', (buf) => {
    const s = buf.toString('utf8');
    if (s.includes('\x03')) process.exit(0); // Ctrl+C
    if (busy || s.includes('\x1b[200~')) return;
    for (const ch of s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b./g, '')) {
      if (ch === '\r' || ch === '\n') {
        if (!typed) continue;
        const prompt = typed;
        typed = '';
        busy = true;
        out('\r\n✢ Working… (esc to interrupt)');
        setTimeout(() => {
          out(`\r\x1b[2K● On it: ${prompt}\r\n\r\n`);
          drawBox();
          busy = false;
        }, 1500);
        return;
      }
      if (ch >= ' ') {
        typed += ch;
        out(ch);
      }
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Smart conductor — drives MCP tools to simulate the real conductor flow
// ───────────────────────────────────────────────────────────────────────────
async function runConductor(prompt) {
  console.log('[Mock Conductor] Starting (prompt length:', prompt.length + ')');

  const { token, port } = readMcpCredentials();
  const projectCwd = extractField(prompt, /PROJECT DIRECTORY:\s*\n([^\n]+)/) || process.cwd();
  const taskSummary = extractField(prompt, /TASK FROM USER:\s*\n([\s\S]+?)\n\nPROJECT DIRECTORY:/) || '(unspecified)';
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';

  console.log('[Mock Conductor] MCP port:', port, 'projectCwd:', projectCwd);

  const mcp = mcpClient({ hostname: '127.0.0.1', port, token });

  // STEP 1 — Post the plan
  await mcp('swarm_send_message', {
    from: 'conductor',
    to: 'all',
    type: 'info',
    content: `Plan: split into 2 tasks (Implement feature, Add tests). User goal: ${String(taskSummary).slice(0, 160)}`,
  });

  // STEP 2 — Create task records BEFORE any terminals
  const task1 = await mcp('swarm_create_task', {
    title: 'Implement feature',
    description: 'Implement the feature described in the user task',
    createdBy: 'conductor',
  });
  const task2 = await mcp('swarm_create_task', {
    title: 'Add tests',
    description: 'Write tests that exercise the new feature',
    createdBy: 'conductor',
  });
  const task1Id = task1.id;
  const task2Id = task2.id;
  console.log('[Mock Conductor] Created tasks:', task1Id, task2Id);

  // STEP 3 — Create agent terminals
  const term1Id = normalizeTerminalId(
    await mcp('create_terminal', { name: 'Claude (Implement feature)', shell, cwd: projectCwd })
  );
  const term2Id = normalizeTerminalId(
    await mcp('create_terminal', { name: 'Claude (Add tests)', shell, cwd: projectCwd })
  );
  console.log('[Mock Conductor] Created terminals:', term1Id, term2Id);

  // STEP 4 — Start agents in interactive mode. MOCK_CLAUDE_SUBMIT=1 starts the first with a model,
  // which makes the stub a Claude Code at its input box (runAtInputBox); otherwise both are the
  // trust-dialog stub.
  const submit = process.env.MOCK_CLAUDE_SUBMIT === '1';
  await mcp('run_command', { terminalId: term1Id, command: `claude --dangerously-skip-permissions${submit ? ' --model haiku' : ''}` });
  await mcp('run_command', { terminalId: term2Id, command: 'claude --dangerously-skip-permissions' });
  await sleep(200);

  // STEP 5 — Send task prompts via write_to_terminal. To the worker at its input box with
  // submit=true, as the real conductor's prompt asks: it waits until the worker is ready, types the
  // task, presses Enter and checks it was taken. The answer is posted for the spec to read; past a
  // minute the swarm goes on without it. The trust-dialog stub never shows an input box, so submit
  // would wait out its 3 minutes there: its task is written raw.
  const task1Text = `You are in ${projectCwd}. Implement the feature. Task ID: ${task1Id}`;
  if (submit) {
    const submitted = await Promise.race([
      mcp('write_to_terminal', { terminalId: term1Id, text: task1Text, submit: true }),
      sleep(60000).then(() => ({ submitted: false, error: 'no answer within 60 s' })),
    ]).catch((err) => ({ submitted: false, error: String((err && err.message) || err) }));
    await mcp('swarm_send_message', {
      from: 'conductor',
      to: 'all',
      type: 'info',
      content: `Sent the task to Claude (Implement feature): ${JSON.stringify(submitted)}`,
    });
  } else {
    await mcp('write_to_terminal', { terminalId: term1Id, text: `${task1Text}\r` });
  }
  await mcp('write_to_terminal', {
    terminalId: term2Id,
    text: `You are in ${projectCwd}. Add tests. Task ID: ${task2Id}\r`,
  });

  // STEP 6 — Mark tasks in-progress, then complete
  await mcp('swarm_update_task', { taskId: task1Id, status: 'in_progress' });
  await mcp('swarm_update_task', { taskId: task2Id, status: 'in_progress' });
  await sleep(200);

  await mcp('swarm_send_message', {
    from: 'conductor',
    to: 'all',
    type: 'info',
    content: 'Agents finished. Marking tasks complete.',
  });

  await mcp('swarm_update_task', {
    taskId: task1Id,
    status: 'completed',
    result: 'Feature implemented',
  });
  await mcp('swarm_update_task', {
    taskId: task2Id,
    status: 'completed',
    result: 'Tests added',
  });

  // STEP 7 — Signal SWARM COMPLETE
  await mcp('swarm_send_message', {
    from: 'conductor',
    to: 'all',
    type: 'result',
    content: 'SWARM COMPLETE: feature implemented and tests added.',
  });

  console.log('[Mock Conductor] Done.');
  process.exit(0);
}

function mcpClient({ hostname, port, token }) {
  return function call(toolName, args) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now() + Math.floor(Math.random() * 1000),
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      });
      const req = http.request(
        {
          hostname,
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${token}`,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) {
                return reject(new Error(`MCP ${toolName}: ${parsed.error.message || JSON.stringify(parsed.error)}`));
              }
              const text = parsed && parsed.result && parsed.result.content && parsed.result.content[0] && parsed.result.content[0].text;
              if (text !== undefined && text !== null) {
                try { resolve(JSON.parse(text)); }
                catch { resolve(text); }
              } else {
                resolve(parsed);
              }
            } catch (e) {
              reject(new Error(`MCP ${toolName}: bad response: ${data.slice(0, 200)}`));
            }
          });
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  };
}

function readMcpCredentials() {
  const userData = userDataDir();
  const token = fs.readFileSync(path.join(userData, 'mcp-token'), 'utf-8').trim();
  let port = 9315;
  try {
    const raw = fs.readFileSync(path.join(userData, 'mcp-port'), 'utf-8').trim();
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) port = parsed;
  } catch { /* use default */ }
  return { token, port };
}

function userDataDir() {
  // Every spec now launches Electron with its own `--user-data-dir`, so the app writes
  // `mcp-token` into a temp profile rather than the OS default below. The spec passes
  // that dir through as TERMPOLIS_TEST_USER_DATA_DIR (see e2eShimEnv); without it this
  // mock read the default path and died with ENOENT before it could drive the swarm.
  if (process.env.TERMPOLIS_TEST_USER_DATA_DIR) {
    return process.env.TERMPOLIS_TEST_USER_DATA_DIR;
  }
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'termpolis');
  }
  return path.join(os.homedir(), '.config', 'termpolis');
}

function extractField(text, regex) {
  const m = text.match(regex);
  return m ? m[1].trim() : null;
}

function normalizeTerminalId(result) {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    if (typeof result.terminalId === 'string') return result.terminalId;
    if (typeof result.id === 'string') return result.id;
  }
  throw new Error(`Expected terminal id, got: ${JSON.stringify(result).slice(0, 200)}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
