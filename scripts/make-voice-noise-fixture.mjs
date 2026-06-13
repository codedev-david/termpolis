#!/usr/bin/env node
// Generates tests/fixtures/voice-noise.wav — a flat, low-level 120Hz tone
// (~0.006 RMS) that mimics steady background hum: ABOVE the silence floor but
// with NO speech dynamics. Fed as the fake microphone in voice-noise-gate.spec.ts
// to prove the app gates the dead-zone (the exact audio that made Whisper
// hallucinate "the"/" you") and never injects a phantom transcript.
//
// Committed as a binary fixture; this script documents how it was produced and
// lets anyone regenerate it deterministically. 16kHz mono 16-bit PCM WAV.
import fs from 'node:fs'
import path from 'node:path'

const RATE = 16000
const SECONDS = 4
const AMP = 0.008 // → RMS ~0.0057, squarely in the 0.0025–0.012 dead-zone
const FREQ = 120

const n = RATE * SECONDS
const data = Buffer.alloc(n * 2)
for (let i = 0; i < n; i++) {
  const s = AMP * Math.sin((2 * Math.PI * FREQ * i) / RATE)
  data.writeInt16LE((Math.max(-1, Math.min(1, s)) * 32767) | 0, i * 2)
}

const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + data.length, 4)
header.write('WAVE', 8)
header.write('fmt ', 12)
header.writeUInt32LE(16, 16) // PCM fmt chunk size
header.writeUInt16LE(1, 20) // audio format = PCM
header.writeUInt16LE(1, 22) // channels = mono
header.writeUInt32LE(RATE, 24)
header.writeUInt32LE(RATE * 2, 28) // byte rate
header.writeUInt16LE(2, 32) // block align
header.writeUInt16LE(16, 34) // bits per sample
header.write('data', 36)
header.writeUInt32LE(data.length, 40)

const out = path.join('tests', 'fixtures', 'voice-noise.wav')
fs.writeFileSync(out, Buffer.concat([header, data]))

let sum = 0
for (let i = 0; i < n; i++) {
  const v = data.readInt16LE(i * 2) / 32767
  sum += v * v
}
console.log(`wrote ${out} (${((44 + data.length) / 1024).toFixed(1)} KB), RMS=${Math.sqrt(sum / n).toFixed(5)}`)
