#!/usr/bin/env bash
#
# Octopus CLI installer (Linux / macOS).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/octopusreview/octopus/master/apps/cli/install/install.sh | sh
#
# What it does:
#   1. Detects your OS + CPU architecture
#   2. Fetches the latest `octp-v*` release from GitHub
#   3. Downloads the matching native binary
#   4. Installs it to ~/.octopus/bin/octp (or $OCTOPUS_INSTALL_DIR)
#   5. Prints a one-line instruction to add ~/.octopus/bin to your PATH (if not already there)
#
# After install, run `octp` to launch the first-run onboarding wizard.
#
# Environment variables:
#   OCTOPUS_INSTALL_DIR  Override install directory (default: $HOME/.octopus/bin)
#   OCTOPUS_INSTALL_REPO Override the GitHub repo (default: octopusreview/octopus)
#   OCTOPUS_INSTALL_TAG  Install a specific tag instead of latest (e.g. octp-v0.2.0)
#
# Exit codes:
#   0 success
#   1 unsupported OS/arch, network failure, or write failure

set -euo pipefail

REPO="${OCTOPUS_INSTALL_REPO:-octopusreview/octopus}"
INSTALL_DIR="${OCTOPUS_INSTALL_DIR:-$HOME/.octopus/bin}"
BINARY_NAME="octp"

# ── Step 1: detect platform ──────────────────────────────────────────────────

uname_s=$(uname -s 2>/dev/null || echo "")
uname_m=$(uname -m 2>/dev/null || echo "")

case "$uname_s" in
  Linux)  os="linux"  ;;
  Darwin) os="darwin" ;;
  *)
    echo "Error: unsupported OS: $uname_s" >&2
    echo "Supported: Linux, macOS. On Windows, use install.ps1 (PowerShell)." >&2
    exit 1
    ;;
esac

case "$uname_m" in
  x86_64|amd64) arch="x64"   ;;
  arm64|aarch64) arch="arm64" ;;
  *)
    echo "Error: unsupported CPU architecture: $uname_m" >&2
    echo "Supported: x86_64, arm64." >&2
    exit 1
    ;;
esac

asset="${BINARY_NAME}-${os}-${arch}"

# ── Step 2: resolve the release tag ──────────────────────────────────────────

if [ -n "${OCTOPUS_INSTALL_TAG:-}" ]; then
  tag="$OCTOPUS_INSTALL_TAG"
  echo "Installing pinned version: $tag"
else
  echo "Looking up latest octp release on $REPO ..."
  # The repo publishes two release trains (web v* and CLI octp-v*) into
  # the same feed. The default page size is 30, but a busy web train can
  # easily push every octp-v* tag off the first page. Walk pages until we
  # find an octp-v* match (or exhaust the feed). 5 pages × 100 = 500 most
  # recent releases is plenty headroom; the API also caps us at 1000.
  # jq isn't assumed (alpine/scratch may not have it); parse with grep+sed.
  tag=""
  page=1
  while [ "$page" -le 5 ]; do
    api_url="https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}"
    page_body=$(curl -fsSL "$api_url" || true)
    if [ -z "$page_body" ]; then break; fi
    found=$(
      echo "$page_body" \
        | grep -E '"tag_name":\s*"octp-v[^"]+' \
        | head -1 \
        | sed -E 's/.*"tag_name":\s*"([^"]+)".*/\1/'
    )
    if [ -n "$found" ]; then
      tag="$found"
      break
    fi
    # Stop if the page returned an empty array — `[]` or a body with no
    # `"tag_name"` field means we've exhausted the feed. The previous
    # check (`grep -q "^["`) was inverted: every API response is a JSON
    # array starting with `[`, including the empty-page case, so the
    # condition was effectively never true and the loop only stopped on
    # the page<=5 cap.
    if ! echo "$page_body" | grep -q '"tag_name"'; then break; fi
    page=$((page + 1))
  done
  if [ -z "$tag" ]; then
    echo "Error: could not find any octp-v* release on $REPO (scanned up to $((page * 100)) releases)." >&2
    echo "If you are testing pre-release, pin a tag with OCTOPUS_INSTALL_TAG=octp-v0.X.Y" >&2
    exit 1
  fi
  echo "Latest release: $tag"
fi

# ── Step 3: download ─────────────────────────────────────────────────────────

download_url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
echo "Downloading $download_url ..."

mkdir -p "$INSTALL_DIR"
tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT

if ! curl -fL --progress-bar -o "$tmp_file" "$download_url"; then
  echo "Error: failed to download $asset from $tag." >&2
  echo "The release might not have a binary for ${os}-${arch}." >&2
  exit 1
fi

# ── Step 3b: verify the SHA256 against the release's SHA256SUMS.txt ──────────
# octp-release.yml publishes SHA256SUMS.txt for every tagged release. Verify
# our download against it so a tampered release asset, a truncated download,
# or a mid-flight swap can't silently end up on PATH and get executed.
sums_url="https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS.txt"
sums_file="$(mktemp)"
trap 'rm -f "$tmp_file" "$sums_file"' EXIT
if curl -fsSL -o "$sums_file" "$sums_url"; then
  expected=$(grep -E "[[:space:]]+(\\./)?${asset}\$" "$sums_file" | awk '{print $1}')
  if [ -z "$expected" ]; then
    echo "Error: SHA256SUMS.txt at $sums_url has no entry for $asset. Refusing to install." >&2
    exit 1
  fi
  verify=1
  if command -v shasum > /dev/null 2>&1; then
    got=$(shasum -a 256 "$tmp_file" | awk '{print $1}')
  elif command -v sha256sum > /dev/null 2>&1; then
    got=$(sha256sum "$tmp_file" | awk '{print $1}')
  else
    # No hashing tool available — explicitly skip the comparison rather
    # than fake-passing it by setting got=$expected. A vacuous comparison
    # reads like an assertion when it's not, which hides the missing
    # check from anyone auditing the script later.
    echo "Warning: no shasum/sha256sum found — proceeding without checksum verification." >&2
    verify=0
  fi
  if [ "$verify" = 1 ] && [ "$got" != "$expected" ]; then
    echo "Error: checksum mismatch for $asset: expected $expected, got $got. Refusing to install." >&2
    exit 1
  fi
else
  echo "Warning: could not fetch $sums_url — proceeding without checksum verification." >&2
fi

# ── Step 4: install ──────────────────────────────────────────────────────────

target="${INSTALL_DIR}/${BINARY_NAME}"
mv "$tmp_file" "$target"
chmod +x "$target"
trap - EXIT

echo ""
echo "Installed $BINARY_NAME → $target"

# ── Step 5: PATH hint ────────────────────────────────────────────────────────

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    echo "$INSTALL_DIR is already on your PATH."
    echo ""
    echo "Get started: $BINARY_NAME"
    ;;
  *)
    echo ""
    echo "Add this line to your shell rc (~/.zshrc, ~/.bashrc, etc.):"
    echo ""
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    echo ""
    echo "Then restart your shell and run: $BINARY_NAME"
    ;;
esac
