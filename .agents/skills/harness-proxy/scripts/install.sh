#!/usr/bin/env bash
set -euo pipefail

REPO="fernando-delosrios-sp/skills"
BIN_NAME="harness-proxy"
INSTALL_DIR="${BIN_DIR:-$HOME/.local/bin}"

# Detect OS
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  darwin) OS="darwin" ;;
  linux) OS="linux" ;;
  *)
    echo "Error: Unsupported operating system: $OS" >&2
    exit 1
    ;;
esac

# Detect Architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)
    echo "Error: Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

ASSET_NAME="${BIN_NAME}-${OS}-${ARCH}"
DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}"

mkdir -p "$INSTALL_DIR"
TARGET_PATH="${INSTALL_DIR}/${BIN_NAME}"

echo "Downloading ${BIN_NAME} (${OS}/${ARCH}) from GitHub Releases..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$DOWNLOAD_URL" -o "$TARGET_PATH"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TARGET_PATH" "$DOWNLOAD_URL"
else
  echo "Error: Neither curl nor wget found." >&2
  exit 1
fi

chmod +x "$TARGET_PATH"
echo "Successfully installed ${BIN_NAME} to ${TARGET_PATH}"

# PATH warning if not present
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "Notice: ${INSTALL_DIR} is not currently in your PATH."
    echo "Add it by adding this to your shell profile (~/.bashrc, ~/.zshrc):"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac
