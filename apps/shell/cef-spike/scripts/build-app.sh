#!/bin/bash
# Assembles "Gustaf CEF Spike.app" with the browser module inside the bundle, where CEF looks
# by default, and signs it ad hoc the way the shell's Tauri build does (`signingIdentity: "-"`).
# Run build-module.sh first: the module's staged files are what goes into Contents/Frameworks.
#
#   CEF_SPIKE_PROFILE=release scripts/build-app.sh
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
. "$here/scripts/env.sh"
profile="${CEF_SPIKE_PROFILE:-debug}"
stage="$CEF_SPIKE_HOME/module/stage"
[ -d "$stage" ] || { echo "run scripts/build-module.sh first" >&2; exit 1; }

(cd "$here" && cargo build $([ "$profile" = release ] && echo --release))

app="$CEF_SPIKE_HOME/app/Gustaf CEF Spike.app"
rm -rf "$CEF_SPIKE_HOME/app" && mkdir -p "$app/Contents/MacOS" "$app/Contents/Frameworks"
cp "$CARGO_TARGET_DIR/$profile/gustaf-cef-spike" "$app/Contents/MacOS/"
cp -R "$stage/." "$app/Contents/Frameworks/"
for helper in "$app/Contents/Frameworks/"*.app; do
  name="$(basename "$helper" .app)"
  cp "$CARGO_TARGET_DIR/$profile/gustaf-cef-helper" "$helper/Contents/MacOS/$name"
done
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>gustaf-cef-spike</string>
  <key>CFBundleIdentifier</key><string>io.github.libes6.gustaf.cef-spike</string>
  <key>CFBundleName</key><string>Gustaf CEF Spike</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>0.0.0</string>
  <key>CFBundleVersion</key><string>0.0.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
if [ -z "${CEF_SPIKE_UNSIGNED:-}" ]; then
  codesign --force --deep --sign - --entitlements "$here/../src-tauri/Entitlements.plist" "$app" 2>&1 | tail -1
fi
echo "app: $app ($(du -sk "$app" | cut -f1) KiB)"
