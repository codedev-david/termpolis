#!/usr/bin/env node
'use strict';

const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('close', () => process.exit(0));

// Startup and trust prompt
console.log('OpenAI Codex v0.1 (mock)');
console.log('Do you trust this directory? [Y/n]');

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
