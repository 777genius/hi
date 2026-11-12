#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$HELPER_DIR/dist/Telegram.app"
OLD_APP_DIR="$HELPER_DIR/dist/MacOSFocusCopyHelper.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
PRODUCT_NAME="MacOSFocusCopyHelper"
BINARY_NAME="Telegram"
RELEASE_BINARY="$HELPER_DIR/.build/release/$PRODUCT_NAME"
SIGNING_IDENTITY="${FOCUS_COPY_SIGNING_IDENTITY:-}"
if [[ -z "$SIGNING_IDENTITY" && -d "$APP_DIR" ]]; then
  SIGNING_IDENTITY="$(codesign -dvvv "$APP_DIR" 2>&1 | sed -n 's/^Authority=\(Developer ID Application:.*\)$/\1/p' | head -n 1)"
fi

swift build -c release --package-path "$HELPER_DIR"

rm -rf "$APP_DIR" "$OLD_APP_DIR"
mkdir -p "$MACOS_DIR"
cp "$RELEASE_BINARY" "$MACOS_DIR/$BINARY_NAME"
chmod +x "$MACOS_DIR/$BINARY_NAME"

cat > "$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Telegram</string>
  <key>CFBundleIdentifier</key>
  <string>ai.hackinterview.focus-copy-helper</string>
  <key>CFBundleName</key>
  <string>Telegram</string>
  <key>CFBundleDisplayName</key>
  <string>Telegram</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

if [[ -n "$SIGNING_IDENTITY" ]]; then
  codesign --force --sign "$SIGNING_IDENTITY" --options runtime "$APP_DIR"
fi

echo "Built $APP_DIR"

if [[ "${1:-}" == "--run" ]]; then
  nohup "$MACOS_DIR/$BINARY_NAME" >/dev/null 2>&1 &
  echo "Started $MACOS_DIR/$BINARY_NAME pid=$!"
fi
