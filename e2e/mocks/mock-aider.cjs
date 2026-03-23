#!/usr/bin/env node
'use strict';

const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('close', () => process.exit(0));

// Startup banner (no trust prompt)
console.log('Aider v0.86.2 (mock)');
console.log('Model: ollama/qwen3-coder with whole edit format');
console.log('Git repo: .');
console.log('Repo-map: disabled');
process.stdout.write('aider> ');

rl.on('line', (input) => {
  const trimmed = input.trim();

  if (trimmed === 'exit' || trimmed === '/exit') {
    process.exit(0);
  }

  if (trimmed.includes('swarm') || trimmed.includes('Your role')) {
    console.log('Working on assigned task...');
    console.log('Aider processing...');
    console.log('done');
  } else {
    console.log(`I'll help with: ${trimmed}`);
  }

  process.stdout.write('aider> ');
});
