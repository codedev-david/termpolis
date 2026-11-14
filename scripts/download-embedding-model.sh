#!/usr/bin/env bash
# Download the local memory models into resources/models/ so electron-builder can
# bundle them for fully-offline semantic search in shipped builds:
#   - bge-small-en-v1.5 (q8 ONNX + tokenizer): the embedder (first-stage recall).
#     MIT-licensed (Xenova ONNX export of BAAI/bge-small-en-v1.5).
#   - ms-marco-MiniLM-L-6-v2 (q8 ONNX + tokenizer, ~23 MB): the cross-encoder that
#     re-ranks the top recall candidates (crossEncoderRerank.ts). Apache-2.0
#     (Xenova ONNX export of cross-encoder/ms-marco-MiniLM-L-6-v2).
#
# Run at CI build time (see .github/workflows/release.yml) — these files are NOT
# committed to the repo (same pattern as download-tools.sh). A network that blocks
# huggingface.co can fetch them with the "Fetch models" workflow instead.
#
# WHY NOT curl (changed 2026-07-13): HuggingFace moved this repo's LFS objects to
# Xet storage. `resolve/main/onnx/model_quantized.onnx` now 302s to a signed
# cas-bridge.xethub.hf.co CloudFront URL that answers 403 AccessDenied. This is
# NOT a curl quirk — Python urllib gets the same 403 and a browser User-Agent does
# not help. Anonymous Xet reads need the xet-auth token exchange that the response
# advertises in its `Link:` header. The plain-text files (tokenizer, config) are
# not LFS-backed and still fetch fine over curl, which is exactly why the breakage
# looked like a partial outage rather than a storage migration.
#
# It failed EVERY platform of the v1.25.11 release with `curl: (22) 403` — and the
# six-retry loop could not save it, because the error was never transient.
# huggingface_hub implements the Xet protocol, so let the supported client fetch
# rather than reimplementing a token dance in bash.
set -euo pipefail

# "<hub repo> <local dir>" per model; every model ships the same four files.
MODELS=(
  "Xenova/bge-small-en-v1.5 resources/models/bge-small-en-v1.5"
  "Xenova/ms-marco-MiniLM-L-6-v2 resources/models/ms-marco-MiniLM-L-6-v2"
)
FILES=(tokenizer.json tokenizer_config.json config.json onnx/model_quantized.onnx)

# GitHub runners ship Python 3 on every platform; on Windows it is `python`, not `python3`.
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "ERROR: python3 not found — required to fetch Xet-backed model files." >&2
  exit 1
fi

# Install into a VENV, not the system interpreter. The macOS runner's Python is Homebrew-managed, so
# a bare `pip install` dies with PEP 668 `externally-managed-environment` — which is exactly how the
# first attempt at this fix failed macOS while Linux and Windows sailed through. A venv sidesteps the
# protection honestly (rather than forcing it with --break-system-packages) and behaves identically on
# all three runners. Note the interpreter lives in Scripts/ on Windows and bin/ everywhere else.
VENV="$(mktemp -d)/hfvenv"
"$PY" -m venv "$VENV"
if [ -x "$VENV/bin/python" ]; then
  VPY="$VENV/bin/python"
else
  VPY="$VENV/Scripts/python.exe"
fi

"$VPY" -m pip install --quiet --disable-pip-version-check --upgrade "huggingface_hub[hf_xet]"

for spec in "${MODELS[@]}"; do
  read -r REPO DIR <<<"$spec"
  mkdir -p "$DIR/onnx"
  echo "Downloading $REPO into $DIR ..."
  "$VPY" - "$REPO" "$DIR" "${FILES[@]}" <<'PY'
import sys, os
from huggingface_hub import hf_hub_download

repo, out, *files = sys.argv[1:]
for f in files:
    # local_dir preserves the repo-relative layout, so onnx/model_quantized.onnx
    # lands under <out>/onnx/ exactly where electron-builder expects it.
    p = hf_hub_download(repo_id=repo, filename=f, local_dir=out)
    print(f"  {f} ({os.path.getsize(p):,} bytes)")
PY

  # hf_hub_download leaves a .cache/huggingface metadata dir inside local_dir. It is only ~14 KB (no
  # blobs), but resources/** is bundled wholesale — so it would ship inside the app for no reason.
  rm -rf "$DIR/.cache"

  # Sanity: the ONNX file must be a real multi-MB model, not an HTML error page.
  # (Kept from the curl era — the check that catches a silently truncated download.)
  SIZE=$(wc -c < "$DIR/onnx/model_quantized.onnx")
  if [ "$SIZE" -lt 1000000 ]; then
    echo "ERROR: $DIR/onnx/model_quantized.onnx is only $SIZE bytes — download failed." >&2
    exit 1
  fi
  echo "Done. Bundled model:"
  ls -la "$DIR" "$DIR/onnx"
done
