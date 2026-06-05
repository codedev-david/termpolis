#!/usr/bin/env bash
# Download the bge-small-en-v1.5 embedding model (q8 ONNX + tokenizer) used by
# the local memory embedder, into resources/models/ so electron-builder can
# bundle it for fully-offline semantic search in shipped builds.
#
# Run at CI build time (see .github/workflows/release.yml) — these ~34 MB of
# files are NOT committed to the repo (same pattern as download-tools.sh).
# MIT-licensed model (Xenova ONNX export of BAAI/bge-small-en-v1.5).
set -euo pipefail

BASE="https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main"
DIR="resources/models/bge-small-en-v1.5"
mkdir -p "$DIR/onnx"

echo "Downloading bge-small embedding model into $DIR ..."
curl -fsSL "$BASE/tokenizer.json"         -o "$DIR/tokenizer.json"
curl -fsSL "$BASE/tokenizer_config.json"  -o "$DIR/tokenizer_config.json"
curl -fsSL "$BASE/config.json"            -o "$DIR/config.json"
curl -fsSL "$BASE/onnx/model_quantized.onnx" -o "$DIR/onnx/model_quantized.onnx"

# Sanity: the ONNX file must be a real multi-MB model, not an HTML error page.
SIZE=$(wc -c < "$DIR/onnx/model_quantized.onnx")
if [ "$SIZE" -lt 1000000 ]; then
  echo "ERROR: model_quantized.onnx is only $SIZE bytes — download failed." >&2
  exit 1
fi

echo "Done. Bundled embedding model:"
ls -la "$DIR" "$DIR/onnx"
