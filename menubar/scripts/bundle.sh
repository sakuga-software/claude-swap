#!/bin/sh
# Builds the release binary and wraps it in build/CswapMenuBar.app.
# UserNotifications needs a bundle with a bundle identifier, so a bare
# binary cannot show notifications.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="$ROOT/build/CswapMenuBar.app"
BUNDLE_ID="com.claude-swap.menubar"
VERSION="${CSWAP_MENUBAR_VERSION:-0.0.0}"

cd "$ROOT"
swift build -c release --product CswapMenuBar
BIN_DIR=$(swift build -c release --show-bin-path)

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/CswapMenuBar" "$APP/Contents/MacOS/CswapMenuBar"

cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>$BUNDLE_ID</string>
    <key>CFBundleName</key>
    <string>claude-swap</string>
    <key>CFBundleDisplayName</key>
    <string>claude-swap</string>
    <key>CFBundleExecutable</key>
    <string>CswapMenuBar</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$VERSION</string>
    <key>CFBundleVersion</key>
    <string>$VERSION</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
EOF

plutil -lint "$APP/Contents/Info.plist" >/dev/null
# An ad-hoc signature gives the bundle a stable identity. Without it, macOS
# can refuse to ask for the notification permission.
codesign --force --sign - "$APP"

echo "$APP"
