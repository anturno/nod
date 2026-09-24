#!/bin/bash
# Installs nod from GitHub Releases: https://nod.anturno.cloud/setup.sh
#   curl -fsSL https://nod.anturno.cloud/setup.sh | bash            # latest release
#   curl -fsSL https://nod.anturno.cloud/setup.sh | bash -s -- v0.1.0
# Environment:
#   NOD_INSTALL_DIR       where the binary goes (default ~/.local/bin)
#   NOD_RELEASE_BASE_URL  archive base, <base>/<version>/nod-<platform>.tar.gz (default GitHub Releases; file:// works)
set -euo pipefail

REPO="anturno/nod"
BASE_URL="${NOD_RELEASE_BASE_URL:-https://github.com/${REPO}/releases/download}"
LATEST_URL="https://api.github.com/repos/${REPO}/releases/latest"
BIN_DIR="${NOD_INSTALL_DIR:-$HOME/.local/bin}"

err() { printf '\033[1;31merror: %s\033[0m\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*" >&2; }

detect_platform() {
  local os arch
  case "$(uname -s)" in
    Linux*)  os="linux" ;;
    Darwin*) os="macos" ;;
    *)       err "unsupported OS: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch="x86_64" ;;
    arm64|aarch64) arch="aarch64" ;;
    *)             err "unsupported architecture: $(uname -m)" ;;
  esac
  echo "${os}-${arch}"
}

fetch_text() {
  local url="$1"
  if command -v curl &>/dev/null; then
    curl -fsSL "$url"
  elif command -v wget &>/dev/null; then
    wget -qO- "$url"
  else
    err "curl or wget required"
  fi
}

get_latest_version() {
  fetch_text "$LATEST_URL" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

download() {
  local url="$1" dest="$2"
  case "$url" in
    file://*) cp "${url#file://}" "$dest" ;;
    *)        fetch_text "$url" > "$dest" ;;
  esac
}

sha256_of() {
  if command -v sha256sum &>/dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum &>/dev/null; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    err "sha256sum or shasum required"
  fi
}

TMP_DIR=""
cleanup() { [ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR"; }
trap cleanup EXIT

is_interactive() { [ -t 0 ] && [ -t 2 ]; }

main() {
  local platform version archive_url expected actual
  platform="$(detect_platform)"

  if [ -n "${1:-}" ]; then
    version="$1"
  else
    version="$(get_latest_version)"
  fi
  [ -n "$version" ] || err "could not determine latest version"

  archive_url="${BASE_URL}/${version}/nod-${platform}.tar.gz"
  info "installing nod ${version#v} (${platform})..."

  TMP_DIR="$(mktemp -d)"
  download "$archive_url" "$TMP_DIR/nod.tar.gz" || err "failed to download $archive_url"
  download "${archive_url}.sha256" "$TMP_DIR/nod.tar.gz.sha256" || err "failed to download ${archive_url}.sha256"

  expected="$(tr -d '\r' < "$TMP_DIR/nod.tar.gz.sha256" | cut -d' ' -f1 | head -n 1)"
  actual="$(sha256_of "$TMP_DIR/nod.tar.gz")"
  [ "$expected" = "$actual" ] || err "downloaded archive failed integrity check"

  tar -xzf "$TMP_DIR/nod.tar.gz" -C "$TMP_DIR" || err "failed to extract release archive"
  [ -f "$TMP_DIR/nod" ] || err "release archive does not contain a nod binary"

  mkdir -p "$BIN_DIR"
  mv "$TMP_DIR/nod" "$BIN_DIR/nod"
  chmod +x "$BIN_DIR/nod"
  info "installed nod ${version#v} to $BIN_DIR/nod"

  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
    local shell_name rc_file=""
    shell_name="$(basename "${SHELL:-/bin/sh}")"
    case "$shell_name" in
      zsh)  rc_file="$HOME/.zshrc" ;;
      bash)
        if [ -f "$HOME/.bash_profile" ]; then
          rc_file="$HOME/.bash_profile"
        else
          rc_file="$HOME/.bashrc"
        fi
        ;;
      fish) rc_file="$HOME/.config/fish/config.fish" ;;
    esac

    local path_line="export PATH=\"${BIN_DIR}:\$PATH\""
    [ "$shell_name" = "fish" ] && path_line="set -gx PATH ${BIN_DIR} \$PATH"

    if [ -n "$rc_file" ]; then
      if ! grep -qF "$BIN_DIR" "$rc_file" 2>/dev/null; then
        mkdir -p "$(dirname "$rc_file")"
        {
          echo ""
          echo "# nod CLI"
          echo "$path_line"
        } >> "$rc_file"
        info "added $BIN_DIR to PATH in $rc_file"
      fi
    fi
    info "restart your shell or run: $path_line"
  fi

  is_interactive || echo "$BIN_DIR/nod"
}

main "$@"
