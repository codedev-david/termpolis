#!/usr/bin/env node
'use strict';

const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('close', () => process.exit(0));

// Startup and the workspace-trust screen, worded the way Codex 0.153.x draws it: the
// cursor opens on "Yes, continue", so Enter trusts. promptAutoDismiss answers this only
// where the user connected the agents and the folder is not home or a root.
console.log('OpenAI Codex v0.1 (mock)');
console.log(`> You are in ${process.cwd()}`);
console.log('');
console.log('Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.');
console.log('');
console.log('› 1. Yes, continue');
console.log('  2. No, quit');
console.log('');
console.log('Press enter to continue');

// Wait for trust confirmation
rl.once('line', () => {
  console.log('Codex ready.');
  process.stdout.write('codex> ');

  rl.on('line', (input) => {
    const trimmed = input.trim();

    if (trimmed === 'exit' || trimmed === '/exit') {
      process.exit(0);
    }

    if (trimmed.includes('swarm') || trimmed.includes('Your role')) {
      console.log('Working on assigned task...');
      console.log('Codex processing...');
    } else {
      console.log(`I'll help with: ${trimmed}`);
    }

    process.stdout.write('codex> ');
  });
});
