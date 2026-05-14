#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HELPER_APP="$REPO_ROOT/tools/macos-focus-copy-helper/dist/Telegram.app"
HELPER_BINARY="$HELPER_APP/Contents/MacOS/Telegram"
HOST_NAME="ai.hackinterview.focus_copy_browser_cache"
EXTENSION_ID="oaheacojmffccgcimpghndlkggkpidjo"
SUPPORT_DIR="$HOME/Library/Application Support/HackInterview"

if [[ ! -x "$HELPER_BINARY" ]]; then
  "$REPO_ROOT/tools/macos-focus-copy-helper/scripts/build-app.sh"
fi

mkdir -p "$SUPPORT_DIR"

write_wrapper() {
  local wrapper="$1"
  local bundle_id="$2"
  cat > "$wrapper" <<HOST
#!/bin/zsh
export FOCUS_COPY_BROWSER_BUNDLE_ID="$bundle_id"
exec "$HELPER_BINARY" --browser-cache-native-host
HOST
  chmod +x "$wrapper"
}

install_manifest() {
  local dir="$1"
  local wrapper="$2"
  mkdir -p "$dir"
  cat > "$dir/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "HackInterview focused browser text cache bridge",
  "path": "$wrapper",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
JSON
  echo "Installed native host manifest: $dir/$HOST_NAME.json"
}

BRAVE_WRAPPER="$SUPPORT_DIR/focus-copy-browser-cache-host-brave.sh"
CHROME_WRAPPER="$SUPPORT_DIR/focus-copy-browser-cache-host-chrome.sh"
EDGE_WRAPPER="$SUPPORT_DIR/focus-copy-browser-cache-host-edge.sh"
CHROMIUM_WRAPPER="$SUPPORT_DIR/focus-copy-browser-cache-host-chromium.sh"

write_wrapper "$BRAVE_WRAPPER" "com.brave.Browser"
write_wrapper "$CHROME_WRAPPER" "com.google.Chrome"
write_wrapper "$EDGE_WRAPPER" "com.microsoft.edgemac"
write_wrapper "$CHROMIUM_WRAPPER" "org.chromium.Chromium"

install_manifest "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" "$BRAVE_WRAPPER"
install_manifest "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" "$CHROME_WRAPPER"
install_manifest "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" "$EDGE_WRAPPER"
install_manifest "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" "$CHROMIUM_WRAPPER"

cat <<INFO

Browser extension path:
  $SCRIPT_DIR

Expected extension id:
  $EXTENSION_ID

Load it as an unpacked extension:
  Brave:  brave://extensions
  Chrome: chrome://extensions
  Edge:   edge://extensions

Enable Developer mode, click "Load unpacked", and select:
  $SCRIPT_DIR

After loading, focus any normal input/textarea on a site and press Ctrl+Shift+A.
INFO
