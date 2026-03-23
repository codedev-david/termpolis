#!/usr/bin/env node
'use strict';

const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('close', () => process.exit(0));

// Simulate slower startup
setTimeout(() => {
  console.log('Gemini CLI v0.1 (mock)');
  console.log('Welcome to Gemini!');
  process.stdout.write('gemini> ');

  rl.on('line', (input) => {
    const trimmed = input.trim();

    if (trimmed === 'exit' || trimmed === '/exit') {
      process.exit(0);
    }

    if (trimmed.includes('swarm') || trimmed.includes('Your role')) {
      console.log('Working on assigned task...');
      console.log('Gemini processing...');
    } else {
      console.log(`I'll help with: ${trimmed}`);
    }

    process.stdout.write('gemini> ');
  });
}, 500);
