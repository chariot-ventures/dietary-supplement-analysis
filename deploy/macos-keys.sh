#!/usr/bin/env bash
# Phase 4, step 3 on macOS: install pocketd and create the Beta TestNet keys.
#
#   bash deploy/macos-keys.sh
#
# - Installs pocketd v0.1.35 from the poktroll GitHub release (SHA-256 checked) into
#   /usr/local/bin, unless that version is already installed. Asks for your password (sudo).
# - Creates three keys with pocketd's "os" keyring, skipping any that exist. The release build
#   of pocketd v0.1.35 on macOS falls back to an encrypted key file instead of the Keychain and
#   asks for a keyring passphrase: use one passphrase for all keys and keep it in your password
#   manager. pocketd asks for it again whenever it signs a transaction.
# - Each new key's 24-word mnemonic is printed HERE ONLY. Save it in your password manager
#   before pressing Enter. It is never written to disk by this script.
# - Writes only the public addresses to deploy/beta-addresses.json, for funding.
#
# Spends nothing: no transactions are sent.
set -euo pipefail

VERSION="v0.1.35"
SHA_ARM64="aa17f136079a708d8412521e9fc5538aec0267a1a721213f9b5e34e31be0aee3"
SHA_AMD64="e1f03ed45b892109924dab56423d29e443ab72ee018e3165a2453d8a55aa5317"
KEYRING="os"
OWNER="${OWNER_KEY:-dsa-owner}"
OPERATOR="${OPERATOR_KEY:-dsa-operator}"
APP="${APP_KEY:-dsa-app}"

cd "$(dirname "$0")/.."

# 1. pocketd
if command -v pocketd >/dev/null 2>&1 && [ "$(pocketd version 2>/dev/null)" = "${VERSION#v}" ]; then
  echo "pocketd ${VERSION#v} already installed at $(command -v pocketd)"
else
  case "$(uname -m)" in
    arm64)  ASSET="pocket_darwin_arm64.tar.gz"; SHA="$SHA_ARM64" ;;
    x86_64) ASSET="pocket_darwin_amd64.tar.gz"; SHA="$SHA_AMD64" ;;
    *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
  esac
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  echo "Downloading $ASSET ($VERSION)..."
  curl -fsSL -o "$TMP/$ASSET" "https://github.com/pokt-network/poktroll/releases/download/$VERSION/$ASSET"
  echo "$SHA  $TMP/$ASSET" | shasum -a 256 -c -
  tar -xzf "$TMP/$ASSET" -C "$TMP"
  echo "Installing to /usr/local/bin/pocketd (sudo)..."
  sudo install -d /usr/local/bin
  sudo install -m 0755 "$TMP/pocketd" /usr/local/bin/pocketd
  hash -r
  echo "pocketd $(pocketd version) installed"
fi

# 2. keys
for NAME in "$OWNER" "$OPERATOR" "$APP"; do
  if pocketd keys show "$NAME" --keyring-backend "$KEYRING" >/dev/null 2>&1; then
    echo "Key '$NAME' already exists; leaving it as is."
    continue
  fi
  echo
  echo "=== Creating key '$NAME' ==="
  pocketd keys add "$NAME" --keyring-backend "$KEYRING"
  echo
  read -r -p "Saved the mnemonic for '$NAME' somewhere safe? Press Enter to continue. "
  clear
done

# 3. public addresses only
addr() { pocketd keys show "$1" -a --keyring-backend "$KEYRING"; }
cat > deploy/beta-addresses.json <<JSON
{
  "network": "beta",
  "keyring_backend": "$KEYRING",
  "owner":       { "key": "$OWNER",    "address": "$(addr "$OWNER")" },
  "operator":    { "key": "$OPERATOR", "address": "$(addr "$OPERATOR")" },
  "application": { "key": "$APP",      "address": "$(addr "$APP")" }
}
JSON
echo
cat deploy/beta-addresses.json
echo
echo "Done. Public addresses written to deploy/beta-addresses.json."
