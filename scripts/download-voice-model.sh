#!/usr/bin/env bash
# Download the whisper-base speech-to-text model (q8 ONNX + tokenizer/config)
# used by the local voice-input transcriber, into resources/models/ AND copy the
# version-matched onnxruntime-web WASM into resources/voice-runtime/ so
# electron-builder can bundle BOTH for fully-offline dictation in shipped builds.
#
# Run at CI build time (see .github/workflows/release.yml), same pattern as
# download-embedding-model.sh — these files are NOT committed to the repo.
# whisper-base ONNX (Xenova export) is MIT-licensed.
#
# Why local + bundled: the renderer Whisper worker runs under the app's strict
# CSP, which (correctly) blocks fetching models from huggingface.co. We bundle
# the model and serve it (plus the ORT wasm) from the localhost asset server
# main already exposes, so audio never leaves the box and there is no egress.
set -euo pipefail

REPO="Xenova/whisper-base"
BASE="https://huggingface.co/${REPO}/resolve/main"
DIR="resources/models/whisper-base"
RT="resources/voice-runtime/ort"
mkdir -p "$DIR/onnx" "$RT"

# Resilient fetch: HuggingFace intermittently rate-limits CI runners (HTTP 429).
# Retry transient failures with backoff so a momentary throttle self-heals.
fetch() {
  curl --fail --silent --show-error --location \
       --retry 6 --retry-delay 5 --retry-all-errors \
       "$1" -o "$2"
}

echo "Downloading whisper-base voice model into $DIR ..."
# Tokenizer + config surface the Whisper feature extractor (mel) and BPE
# vocab/merges that Transformers.js needs to build the ASR pipeline.
for f in config.json generation_config.json preprocessor_config.json \
         tokenizer.json tokenizer_config.json vocab.json merges.txt \
         added_tokens.json normalizer.json special_tokens_map.json; do
  fetch "$BASE/$f" "$DIR/$f"
done

# q8 weights only (encoder + MERGED decoder) — the smallest combo that runs the
# full encoder→decoder loop. ~77 MB total vs ~400 MB for fp16/uint8 variants.
fetch "$BASE/onnx/encoder_model_quantized.onnx"        "$DIR/onnx/encoder_model_quantized.onnx"
fetch "$BASE/onnx/decoder_model_merged_quantized.onnx" "$DIR/onnx/decoder_model_merged_quantized.onnx"

# Sanity: the ONNX files must be real multi-MB models, not HTML error pages.
for m in "$DIR/onnx/encoder_model_quantized.onnx" "$DIR/onnx/decoder_model_merged_quantized.onnx"; do
  SIZE=$(wc -c < "$m")
  if [ "$SIZE" -lt 1000000 ]; then
    echo "ERROR: $m is only $SIZE bytes — download failed." >&2
    exit 1
  fi
done

# Copy the onnxruntime-web WASM runtime that the renderer's Whisper worker loads.
# Pinned to the SAME onnxruntime-web version (package.json dep), so the runtime
# always matches the bundled JS glue — no CDN, no version drift.
echo "Copying version-matched onnxruntime-web WASM runtime into $RT ..."
ORT_DIST="node_modules/onnxruntime-web/dist"
if [ ! -d "$ORT_DIST" ]; then
  echo "ERROR: $ORT_DIST not found — run npm ci first." >&2
  exit 1
fi
# onnxruntime-web ships its wasm backend as a `.mjs` loader + `.wasm` pair per
# variant (plain, asyncify, jsep, jspi). At runtime ORT DYNAMICALLY imports the
# variant .mjs it selects (asyncify for our device='wasm', single-thread,
# no-proxy config) from wasm.wasmPaths. v1.12.0-v1.12.2 shipped only 2 of these
# `.wasm` and ZERO `.mjs` loaders, so that import 404'd and voice died with
# "no available backend found". Copy the COMPLETE family via glob so the bundled
# set can never drift from what the loader requests.
shopt -s nullglob
ORT_RUNTIME=("$ORT_DIST"/ort-wasm-simd-threaded.*)
if [ ${#ORT_RUNTIME[@]} -eq 0 ]; then
  echo "ERROR: no ort-wasm-simd-threaded.* runtime files in $ORT_DIST — onnxruntime-web layout changed?" >&2
  exit 1
fi
cp "${ORT_RUNTIME[@]}" "$RT/"

# The renderer imports the asyncify variant; its .mjs loader + .wasm MUST be
# present or the worker fails with "Failed to fetch dynamically imported module".
for required in ort-wasm-simd-threaded.asyncify.mjs ort-wasm-simd-threaded.asyncify.wasm; do
  if [ ! -s "$RT/$required" ]; then
    echo "ERROR: required ORT runtime file missing after copy: $RT/$required" >&2
    exit 1
  fi
done

echo "Done. Bundled voice model + runtime:"
ls -la "$DIR" "$DIR/onnx" "$RT"
