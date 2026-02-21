#!/usr/bin/env bash
set -euo pipefail

BOLD="\033[1m"
GREEN="\033[1;32m"
YELLOW="\033[1;33m"
RED="\033[1;31m"
CYAN="\033[1;36m"
RESET="\033[0m"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$SCRIPT_DIR/extension"
CORE_DIR="$SCRIPT_DIR/core"
PKG="$EXT_DIR/package.json"
PKG_BACKUP="$EXT_DIR/package.json.bak"
BIN_DIR="$EXT_DIR/bin"

# Ensure we restore package.json and clean up bin/ on exit (even on failure)
cleanup() {
    if [[ -f "$PKG_BACKUP" ]]; then
        mv "$PKG_BACKUP" "$PKG"
        echo -e "${YELLOW}Restored original package.json${RESET}"
    fi
    rm -f "$BIN_DIR/eisen-core" "$BIN_DIR/eisen-core.exe"
}
trap cleanup EXIT

# --- Detect host platform -> determine which targets we can build natively ---
# Maps: OS/arch -> (vsce_target, cargo_target, pkg_name, display_name)
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"

TARGETS=()

case "${HOST_OS}-${HOST_ARCH}" in
    Darwin-arm64)
        TARGETS+=("darwin-arm64|aarch64-apple-darwin|context-eisen-arm|Eisen (arm)")
        ;;
    Darwin-x86_64)
        TARGETS+=("darwin-x64|x86_64-apple-darwin|context-eisen|Eisen")
        ;;
    Linux-x86_64)
        TARGETS+=("linux-x64|x86_64-unknown-linux-gnu|context-eisen|Eisen")
        ;;
    Linux-aarch64)
        TARGETS+=("linux-arm64|aarch64-unknown-linux-gnu|context-eisen-arm|Eisen (arm)")
        ;;
    *)
        echo -e "${RED}Error: Unsupported host platform: ${HOST_OS}-${HOST_ARCH}${RESET}"
        echo -e "${YELLOW}This script builds the extension for the current host platform only.${RESET}"
        echo -e "${YELLOW}Cross-compilation requires a CI pipeline with per-platform runners.${RESET}"
        exit 1
        ;;
esac

echo -e "${CYAN}Host: ${HOST_OS}-${HOST_ARCH} -> building ${#TARGETS[@]} target(s)${RESET}"

# Back up original package.json
cp "$PKG" "$PKG_BACKUP"

echo -e "${CYAN}${BOLD}=== Building VS Code Extension ===${RESET}"
echo ""

# --- Helper to patch package.json fields ---
# Usage: patch_package <name> <displayName> <description>
patch_package() {
    # Restore from backup before each patch
    cp "$PKG_BACKUP" "$PKG"

    node -e "
        const fs = require('fs');
        const [, name, displayName, description] = process.argv;
        const pkg = JSON.parse(fs.readFileSync('$PKG', 'utf8'));
        pkg.name = name;
        pkg.displayName = displayName;
        pkg.description = description;
        fs.writeFileSync('$PKG', JSON.stringify(pkg, null, 2) + '\n');
    " -- "$1" "$2" "$3"
}

# --- Helper to build eisen-core for a Cargo target and stage into extension/bin/ ---
# Usage: build_core <cargo-target>
build_core() {
    local cargo_target="$1"

    echo -e "${CYAN}  Building eisen-core for ${cargo_target}...${RESET}"

    # Check that the Rust target is installed
    if ! rustup target list --installed 2>/dev/null | grep -q "^${cargo_target}$"; then
        echo -e "${RED}Error: Rust target '${cargo_target}' is not installed.${RESET}"
        echo -e "${YELLOW}Install it with: rustup target add ${cargo_target}${RESET}"
        exit 1
    fi

    cargo build --release \
        --manifest-path "$CORE_DIR/Cargo.toml" \
        --target "$cargo_target"

    local binary="$CORE_DIR/target/${cargo_target}/release/eisen-core"
    if [[ ! -f "$binary" ]]; then
        echo -e "${RED}Error: eisen-core binary not found at ${binary}${RESET}"
        exit 1
    fi

    mkdir -p "$BIN_DIR"
    cp "$binary" "$BIN_DIR/eisen-core"
    chmod +x "$BIN_DIR/eisen-core"
    echo -e "${GREEN}  Staged eisen-core ($(du -h "$BIN_DIR/eisen-core" | cut -f1)) into extension/bin/${RESET}"
}

# --- Build each target ---
BUILT_VSIX=()
COUNT=0
TOTAL=${#TARGETS[@]}

for entry in "${TARGETS[@]}"; do
    IFS='|' read -r vsce_target cargo_target pkg_name display_name <<< "$entry"
    COUNT=$((COUNT + 1))

    echo -e "${CYAN}[${COUNT}/${TOTAL}] Building extension (${vsce_target})...${RESET}"

    build_core "$cargo_target"

    patch_package \
        "$pkg_name" \
        "$display_name" \
        "Live visualization of AI agent activity with integrated chat"

    (cd "$EXT_DIR" && npx @vscode/vsce package --no-dependencies --target "$vsce_target")
    rm -f "$BIN_DIR/eisen-core"

    VSIX=$(ls -t "$EXT_DIR"/*.vsix 2>/dev/null | head -1)
    BUILT_VSIX+=("$vsce_target|$VSIX")
    echo -e "${GREEN}  -> Built: ${VSIX}${RESET}"
    echo ""
done

# --- Done ---
echo -e "${GREEN}${BOLD}=== Extension build complete ===${RESET}"
echo ""
for entry in "${BUILT_VSIX[@]}"; do
    IFS='|' read -r target vsix <<< "$entry"
    echo -e "  ${target}: ${BOLD}${vsix}${RESET}"
done
echo ""
