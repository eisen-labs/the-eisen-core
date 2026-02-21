#!/usr/bin/env bash
set -euo pipefail

BOLD="\033[1m"
GREEN="\033[1;32m"
YELLOW="\033[1;33m"
RED="\033[1;31m"
CYAN="\033[1;36m"
RESET="\033[0m"

CORE_DIR="$(cd "$(dirname "$0")/core" && pwd)"
BINARY_NAME="eisen-core"

echo -e "${CYAN}Building ${BINARY_NAME} (release)...${RESET}"
echo ""

cargo build --release --manifest-path "$CORE_DIR/Cargo.toml"

BINARY_PATH="$CORE_DIR/target/release/$BINARY_NAME"

if [[ ! -f "$BINARY_PATH" ]]; then
    echo -e "${RED}Build failed — binary not found at ${BINARY_PATH}${RESET}"
    exit 1
fi

echo ""
echo -e "${GREEN}Build successful!${RESET}"
echo -e "Binary: ${BOLD}${BINARY_PATH}${RESET}"
echo ""

# --- Prompt user to add to PATH ---
echo -e "${YELLOW}Would you like to add ${BINARY_NAME} to your \$PATH? [y/N]${RESET}"
read -r answer

if [[ "$answer" =~ ^[Yy]$ ]]; then
    INSTALL_DIR="$HOME/.local/bin"
    mkdir -p "$INSTALL_DIR"
    cp "$BINARY_PATH" "$INSTALL_DIR/$BINARY_NAME"
    chmod +x "$INSTALL_DIR/$BINARY_NAME"

    # Check if INSTALL_DIR is already in PATH
    if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
        SHELL_NAME="$(basename "$SHELL")"
        case "$SHELL_NAME" in
            zsh)  RC_FILE="$HOME/.zshrc" ;;
            bash) RC_FILE="$HOME/.bashrc" ;;
            fish) RC_FILE="$HOME/.config/fish/config.fish" ;;
            *)    RC_FILE="$HOME/.profile" ;;
        esac

        echo "" >> "$RC_FILE"
        echo "# Added by eisen build-core.sh" >> "$RC_FILE"
        echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$RC_FILE"

        echo ""
        echo -e "${GREEN}Installed ${BINARY_NAME} to ${INSTALL_DIR}${RESET}"
        echo -e "${YELLOW}Added ${INSTALL_DIR} to PATH in ${RC_FILE}${RESET}"
        echo -e "Run ${BOLD}source ${RC_FILE}${RESET} or open a new terminal to use it."
    else
        echo ""
        echo -e "${GREEN}Installed ${BINARY_NAME} to ${INSTALL_DIR}${RESET}"
        echo -e "${INSTALL_DIR} is already in your \$PATH — you're good to go."
    fi

    echo ""
    echo -e "${CYAN}Usage:${RESET}"
    echo -e "  ${BOLD}${BINARY_NAME} [--port N] observe -- <agent-command> [agent-args...]${RESET}"
    echo ""
    echo -e "Example:"
    echo -e "  ${BOLD}${BINARY_NAME} observe -- claude-code --stdio${RESET}"
else
    echo ""
    echo -e "${CYAN}Skipping PATH installation.${RESET}"
    echo -e "You can run the binary directly from the build output:"
    echo ""
    echo -e "${CYAN}Usage:${RESET}"
    echo -e "  ${BOLD}${BINARY_PATH} [--port N] observe -- <agent-command> [agent-args...]${RESET}"
    echo ""
    echo -e "Example:"
    echo -e "  ${BOLD}${BINARY_PATH} observe -- claude-code --stdio${RESET}"
fi
