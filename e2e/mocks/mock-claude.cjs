#!/usr/bin/env node
'use strict';

const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('close', () => process.exit(0));

// Trust prompt
console.log('Quick safety check: Is this a project you created or one you trust?');
console.log('Yes, I trust this folder');
console.log('Enter to confirm');

// Wait for trust confirmation
rl.once('line', () => {
  // Startup banner
  console.log('Claude Code v1.0.0 (mock)');
  console.log('Model: claude-opus-4-6');
  process.stdout.write('claude> ');

  rl.on('line', (input) => {
    const trimmed = input.trim();

    if (trimmed === 'exit' || trimmed === '/exit') {
      process.exit(0);
    }

    if (trimmed.includes('swarm') || trimmed.includes('Your role')) {
      console.log('Working on assigned task...');
      console.log('Claude Code processing...');
    } else {
      console.log(`I'll help with: ${trimmed}`);
    }

    process.stdout.write('claude> ');
  });
});
