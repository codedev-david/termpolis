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

# Resilient fetch: HuggingFace intermittently rate-limits CI runners (HTTP 429),
# which previously failed the whole build/release on the very first request.
# Retry transient failures (429 / 5xx / network) with backoff so a momentary
# throttle self-heals instead of breaking the release.
fetch() {
  curl --fail --silent --show-error --location \
       --retry 6 --retry-delay 5 --retry-all-errors \
       "$1" -o "$2"
}

echo "Downloading bge-small embedding model into $DIR ..."
fetch "$BASE/tokenizer.json"              "$DIR/tokenizer.json"
fetch "$BASE/tokenizer_config.json"       "$DIR/tokenizer_config.json"
fetch "$BASE/config.json"                 "$DIR/config.json"
fetch "$BASE/onnx/model_quantized.onnx"   "$DIR/onnx/model_quantized.onnx"

# Sanity: the ONNX file must be a real multi-MB model, not an HTML error page.
SIZE=$(wc -c < "$DIR/onnx/model_quantized.onnx")
if [ "$SIZE" -lt 1000000 ]; then
  echo "ERROR: model_quantized.onnx is only $SIZE bytes — download failed." >&2
  exit 1
fi

echo "Done. Bundled embedding model:"
ls -la "$DIR" "$DIR/onnx"
