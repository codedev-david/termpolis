#!/bin/bash
# Download latest jq, yq, nano for all platforms.
# Run before packaging: bash scripts/download-tools.sh
# Non-fatal — if any download fails, the build continues without that tool.

set -u  # Error on undefined vars, but don't exit on failures (no -e)

TOOLS_DIR="resources/tools"
mkdir -p "$TOOLS_DIR/win32" "$TOOLS_DIR/darwin" "$TOOLS_DIR/linux"

get_latest_tag() {
  local repo="$1"
  local location
  location=$(curl -sI "https://github.com/${repo}/releases/latest" 2>/dev/null | grep -i '^location:' | sed 's|.*/tag/||;s/\r//;s/\n//')
  echo "$location"
}

# ── jq ──────────────────────────────────────────────
echo "==> Downloading jq..."
JQ_VERSION=$(get_latest_tag "jqlang/jq")
if [ -n "$JQ_VERSION" ]; then
  echo "    version: $JQ_VERSION"
  JQ_BASE="https://github.com/jqlang/jq/releases/download/${JQ_VERSION}"
  curl -sL "${JQ_BASE}/jq-windows-amd64.exe" -o "$TOOLS_DIR/win32/jq.exe" || echo "    WARN: jq win32 download failed"
  curl -sL "${JQ_BASE}/jq-macos-amd64"       -o "$TOOLS_DIR/darwin/jq"    || echo "    WARN: jq darwin download failed"
  curl -sL "${JQ_BASE}/jq-linux-amd64"        -o "$TOOLS_DIR/linux/jq"    || echo "    WARN: jq linux download failed"
  chmod +x "$TOOLS_DIR/darwin/jq" "$TOOLS_DIR/linux/jq" 2>/dev/null
  echo "    done"
else
  echo "    WARN: could not detect jq version, skipping"
fi

# ── yq ──────────────────────────────────────────────
echo "==> Downloading yq..."
YQ_VERSION=$(get_latest_tag "mikefarah/yq")
if [ -n "$YQ_VERSION" ]; then
  echo "    version: $YQ_VERSION"
  YQ_BASE="https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}"
  curl -sL "${YQ_BASE}/yq_windows_amd64.exe" -o "$TOOLS_DIR/win32/yq.exe" || echo "    WARN: yq win32 download failed"
  curl -sL "${YQ_BASE}/yq_darwin_amd64"       -o "$TOOLS_DIR/darwin/yq"    || echo "    WARN: yq darwin download failed"
  curl -sL "${YQ_BASE}/yq_linux_amd64"        -o "$TOOLS_DIR/linux/yq"    || echo "    WARN: yq linux download failed"
  chmod +x "$TOOLS_DIR/darwin/yq" "$TOOLS_DIR/linux/yq" 2>/dev/null
  echo "    done"
else
  echo "    WARN: could not detect yq version, skipping"
fi

# ── nano (Windows only — pre-installed on macOS/Linux) ──
echo "==> Downloading nano for Windows..."
NANO_VERSION=$(get_latest_tag "okibcn/nano-for-windows")
if [ -n "$NANO_VERSION" ]; then
  echo "    version: $NANO_VERSION"
  # The release filenames use the tag directly
  NANO_URL="https://github.com/okibcn/nano-for-windows/releases/download/${NANO_VERSION}/nano-for-windows_win64.zip"
  NANO_TMP=$(mktemp -d)
  if curl -sL "$NANO_URL" -o "$NANO_TMP/nano.zip" && [ -s "$NANO_TMP/nano.zip" ]; then
    if command -v unzip &>/dev/null; then
      unzip -q -o "$NANO_TMP/nano.zip" -d "$NANO_TMP" 2>/dev/null
    elif command -v 7z &>/dev/null; then
      7z x -o"$NANO_TMP" "$NANO_TMP/nano.zip" -y >/dev/null 2>&1
    elif command -v powershell &>/dev/null; then
      powershell -NoProfile -Command "Expand-Archive -Path '$NANO_TMP/nano.zip' -DestinationPath '$NANO_TMP' -Force" 2>/dev/null
    fi
    NANO_EXE=$(find "$NANO_TMP" -name "nano.exe" -type f 2>/dev/null | head -1)
    if [ -n "$NANO_EXE" ]; then
      cp "$NANO_EXE" "$TOOLS_DIR/win32/nano.exe"
      echo "    done"
    else
      echo "    WARN: nano.exe not found in archive"
    fi
  else
    echo "    WARN: nano download failed"
  fi
  rm -rf "$NANO_TMP"
else
  echo "    WARN: could not detect nano version, skipping"
fi

# curl is pre-installed on all modern OS — skip bundling
echo "==> Skipping curl (pre-installed on Windows 10+, macOS, Linux)"

# ── Summary ─────────────────────────────────────────
echo ""
echo "==> Bundled tools:"
for platform in win32 darwin linux; do
  echo "    $platform/:"
  ls -lh "$TOOLS_DIR/$platform/" 2>/dev/null | grep -v total | grep -v .gitkeep | awk '{print "      " $NF " (" $5 ")"}'
done
echo ""
echo "Done. Build can proceed regardless of any warnings above."
