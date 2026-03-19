#!/bin/bash
# Download bundled CLI tools for Termpolis
# Run this script before packaging to populate resources/tools/

set -e

TOOLS_DIR="resources/tools"
mkdir -p "$TOOLS_DIR/win32" "$TOOLS_DIR/darwin" "$TOOLS_DIR/linux"

echo "Download jq, yq, curl for each platform and place in the appropriate directory:"
echo ""
echo "jq:"
echo "  win32:  https://github.com/jqlang/jq/releases/latest -> jq.exe"
echo "  darwin: https://github.com/jqlang/jq/releases/latest -> jq"
echo "  linux:  https://github.com/jqlang/jq/releases/latest -> jq"
echo ""
echo "yq:"
echo "  win32:  https://github.com/mikefarah/yq/releases/latest -> yq.exe"
echo "  darwin: https://github.com/mikefarah/yq/releases/latest -> yq"
echo "  linux:  https://github.com/mikefarah/yq/releases/latest -> yq"
echo ""
echo "curl: (only bundle as fallback if not on system PATH)"
echo "  win32:  https://curl.se/windows/ -> curl.exe"
echo "  darwin: pre-installed"
echo "  linux:  pre-installed on most distros"
