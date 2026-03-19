#!/bin/bash
# Download latest jq, yq, and curl for all platforms.
# Run before packaging: bash scripts/download-tools.sh
# Requires: curl, unzip

set -e

TOOLS_DIR="resources/tools"
mkdir -p "$TOOLS_DIR/win32" "$TOOLS_DIR/darwin" "$TOOLS_DIR/linux"

echo "==> Fetching latest release tags..."

JQ_VERSION=$(curl -sI https://github.com/jqlang/jq/releases/latest | grep -i '^location:' | sed 's|.*/tag/||;s/\r//')
YQ_VERSION=$(curl -sI https://github.com/mikefarah/yq/releases/latest | grep -i '^location:' | sed 's|.*/tag/||;s/\r//')
CURL_VERSION=$(curl -sI https://github.com/curl/curl-for-win/releases/latest | grep -i '^location:' | sed 's|.*/tag/||;s/\r//')

echo "    jq:   $JQ_VERSION"
echo "    yq:   $YQ_VERSION"
echo "    curl: $CURL_VERSION"
echo ""

# ── jq ──────────────────────────────────────────────
echo "==> Downloading jq $JQ_VERSION..."

JQ_BASE="https://github.com/jqlang/jq/releases/download/${JQ_VERSION}"

curl -sL "${JQ_BASE}/jq-windows-amd64.exe" -o "$TOOLS_DIR/win32/jq.exe"
curl -sL "${JQ_BASE}/jq-macos-amd64"       -o "$TOOLS_DIR/darwin/jq"
curl -sL "${JQ_BASE}/jq-linux-amd64"        -o "$TOOLS_DIR/linux/jq"

chmod +x "$TOOLS_DIR/darwin/jq" "$TOOLS_DIR/linux/jq"
echo "    done"

# ── yq ──────────────────────────────────────────────
echo "==> Downloading yq $YQ_VERSION..."

YQ_BASE="https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}"

curl -sL "${YQ_BASE}/yq_windows_amd64.exe" -o "$TOOLS_DIR/win32/yq.exe"
curl -sL "${YQ_BASE}/yq_darwin_amd64"       -o "$TOOLS_DIR/darwin/yq"
curl -sL "${YQ_BASE}/yq_linux_amd64"        -o "$TOOLS_DIR/linux/yq"

chmod +x "$TOOLS_DIR/darwin/yq" "$TOOLS_DIR/linux/yq"
echo "    done"

# ── curl (Windows only — pre-installed on macOS/Linux) ──
echo "==> Downloading curl for Windows..."

CURL_ZIP_URL="https://github.com/curl/curl-for-win/releases/download/${CURL_VERSION}/curl-${CURL_VERSION#v}-x86_64-mingw32.zip"
CURL_TMP=$(mktemp -d)

curl -sL "$CURL_ZIP_URL" -o "$CURL_TMP/curl.zip"
unzip -q -o "$CURL_TMP/curl.zip" -d "$CURL_TMP"
# Find curl.exe inside the extracted directory
CURL_EXE=$(find "$CURL_TMP" -name "curl.exe" -type f | head -1)
if [ -n "$CURL_EXE" ]; then
  cp "$CURL_EXE" "$TOOLS_DIR/win32/curl.exe"
  echo "    done"
else
  echo "    WARNING: curl.exe not found in archive, skipping"
fi
rm -rf "$CURL_TMP"

# ── Summary ─────────────────────────────────────────
echo ""
echo "==> Bundled tools:"
for platform in win32 darwin linux; do
  echo "    $platform/:"
  ls -lh "$TOOLS_DIR/$platform/" 2>/dev/null | grep -v total | grep -v .gitkeep | awk '{print "      " $NF " (" $5 ")"}'
done
echo ""
echo "Done. Tools are ready for packaging."
