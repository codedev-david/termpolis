#!/usr/bin/env bash
# Pre-fetch the OPT-IN cross-encoder NLI model used by nliContradict.ts (the memory_conflicts NLI
# upgrade). The NLI path ships DISABLED (setNliConflictsEnabled) and is gated behind the recall/
# conflict benchmark per the learning-soundness rule — this script only caches the model locally so
# the strictly-local transformers.js pipeline can load it once you turn the path on. Mirrors
# scripts/download-embedding-model.sh.
set -euo pipefail
MODEL="Xenova/nli-deberta-v3-xsmall"
echo "Pre-fetching NLI cross-encoder: $MODEL"
node -e "
const { pipeline } = require('@huggingface/transformers');
(async () => {
  await pipeline('text-classification', '$MODEL');
  console.log('NLI model cached OK');
})().catch((e) => { console.error('NLI model download failed:', e.message); process.exit(1); });
"
