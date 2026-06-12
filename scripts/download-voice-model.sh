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

# Copy the onnxruntime-web WASM that Transformers.js 4.2.0 loads at runtime.
# Pinned to the SAME onnxruntime-web version (package.json dep), so the binary
# always matches the bundled JS glue — no CDN, no version drift.
echo "Copying version-matched onnxruntime-web WASM into $RT ..."
ORT_DIST="node_modules/onnxruntime-web/dist"
if [ ! -d "$ORT_DIST" ]; then
  echo "ERROR: $ORT_DIST not found — run npm ci first." >&2
  exit 1
fi
# .jsep.wasm = WebGPU/JSEP build; plain .wasm = CPU build. Ship both so either
# device path resolves offline.
cp "$ORT_DIST/ort-wasm-simd-threaded.wasm"      "$RT/"
cp "$ORT_DIST/ort-wasm-simd-threaded.jsep.wasm" "$RT/"

echo "Done. Bundled voice model + runtime:"
ls -la "$DIR" "$DIR/onnx" "$RT"
