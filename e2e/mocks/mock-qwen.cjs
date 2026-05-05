#!/usr/bin/env node
'use strict';

const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('close', () => process.exit(0));

setTimeout(() => {
  console.log('Qwen Code v0.15.6 (mock)');
  console.log('Welcome to Qwen Code!');
  process.stdout.write('qwen> ');

  rl.on('line', (input) => {
    const trimmed = input.trim();

    if (trimmed === 'exit' || trimmed === '/exit') {
      process.exit(0);
    }

    if (trimmed.includes('swarm') || trimmed.includes('Your role')) {
      console.log('Working on assigned task...');
      console.log('Qwen processing...');
    } else {
      console.log(`I'll help with: ${trimmed}`);
    }

    process.stdout.write('qwen> ');
  });
}, 500);
