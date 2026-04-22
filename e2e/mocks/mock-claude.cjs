#!/usr/bin/env node
'use strict';

/**
 * Mock Claude Code binary used by E2E tests.
 *
 * Three modes:
 *   1. `--version`               → print a version banner and exit 0
 *   2. `-p "<prompt>"`           → run as the Swarm Conductor: drive MCP tools
 *                                  to create tasks, spawn agent terminals, mark
 *                                  them complete, and signal SWARM COMPLETE.
 *   3. (no recognized args)      → interactive stub used by swarm-integration
 *                                  (trust prompt + `I'll help with: X` echoes).
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

// --- Mode 2: -p <prompt> (smart conductor) ---
const pIdx = argv.indexOf('-p');
if (pIdx !== -1) {
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
  runConductor(argv[pIdx + 1] || '').catch((err) => {
    console.error('[Mock Conductor] fatal:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
} else {
  runInteractive();
}

// ───────────────────────────────────────────────────────────────────────────
// Interactive stub (preserves existing swarm-integration.spec.ts behavior)
// ───────────────────────────────────────────────────────────────────────────
function runInteractive() {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('close', () => process.exit(0));

  console.log('Quick safety check: Is this a project you created or one you trust?');
  console.log('Yes, I trust this folder');
  console.log('Enter to confirm');

  rl.once('line', () => {
    console.log('Claude Code v1.0.0 (mock)');
    console.log('Model: claude-opus-4-6');
    process.stdout.write('claude> ');

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

  // STEP 4 — Start agents in interactive mode (command stays as-is; agent will
  // just report "command not found" in the PTY, which is fine — we only need
  // the terminal objects to exist in the store)
  await mcp('run_command', { terminalId: term1Id, command: 'claude --dangerously-skip-permissions' });
  await mcp('run_command', { terminalId: term2Id, command: 'claude --dangerously-skip-permissions' });
  await sleep(200);

  // STEP 5 — Send task prompts via write_to_terminal
  await mcp('write_to_terminal', {
    terminalId: term1Id,
    text: `You are in ${projectCwd}. Implement the feature. Task ID: ${task1Id}\r`,
  });
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
