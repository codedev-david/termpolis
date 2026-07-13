#!/usr/bin/env bash
# Download the bge-small-en-v1.5 embedding model (q8 ONNX + tokenizer) used by
# the local memory embedder, into resources/models/ so electron-builder can
# bundle it for fully-offline semantic search in shipped builds.
#
# Run at CI build time (see .github/workflows/release.yml) — these ~34 MB of
# files are NOT committed to the repo (same pattern as download-tools.sh).
# MIT-licensed model (Xenova ONNX export of BAAI/bge-small-en-v1.5).
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

REPO="Xenova/bge-small-en-v1.5"
DIR="resources/models/bge-small-en-v1.5"
FILES=(tokenizer.json tokenizer_config.json config.json onnx/model_quantized.onnx)

mkdir -p "$DIR/onnx"

# GitHub runners ship Python 3 on every platform; on Windows it is `python`, not `python3`.
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "ERROR: python3 not found — required to fetch Xet-backed model files." >&2
  exit 1
fi

echo "Downloading $REPO into $DIR ..."
"$PY" -m pip install --quiet --disable-pip-version-check --upgrade "huggingface_hub[hf_xet]"

"$PY" - "$REPO" "$DIR" "${FILES[@]}" <<'PY'
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
  echo "ERROR: model_quantized.onnx is only $SIZE bytes — download failed." >&2
  exit 1
fi

echo "Done. Bundled embedding model:"
ls -la "$DIR" "$DIR/onnx"
