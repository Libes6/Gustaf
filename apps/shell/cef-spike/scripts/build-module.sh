#!/bin/bash
# Packs the browser module: the CEF framework cef-rs downloaded plus the helper apps Chromium
# starts its child processes from. Writes the archive outside the repo and its SHA-256 into
# module.json, which the app embeds. Rebuild the app afterwards.
#
#   scripts/build-module.sh [base-url]     # default http://127.0.0.1:8765
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
. "$here/scripts/env.sh"
base_url="${1:-http://127.0.0.1:8765}"
profile="${CEF_SPIKE_PROFILE:-debug}"

(cd "$here" && cargo build --bin gustaf-cef-helper $([ "$profile" = release ] && echo --release))

cef_dir="$(ls -d "$CEF_PATH"/*/cef_macos_aarch64 | tail -1)"
version="$(basename "$(dirname "$cef_dir")")"
out="$CEF_SPIKE_HOME/module"
stage="$out/stage"
rm -rf "$out" && mkdir -p "$stage"

cp -R "$cef_dir/Chromium Embedded Framework.framework" "$stage/"

# One helper serves every child process type when `browser_subprocess_path` names it.
name="Gustaf Browser Helper"
app="$stage/$name.app/Contents"
mkdir -p "$app/MacOS"
cp "$CARGO_TARGET_DIR/$profile/gustaf-cef-helper" "$app/MacOS/$name"
cat > "$app/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>$name</string>
  <key>CFBundleIdentifier</key><string>io.github.libes6.gustaf.browser.helper</string>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><string>1</string>
  <key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
EOF

archive="$out/browser-cef-$version-macos-arm64.tar.xz"
# COPYFILE_DISABLE keeps AppleDouble files (and with them xattrs) out of the archive.
COPYFILE_DISABLE=1 tar -C "$stage" -cJf "$archive" .
sha="$(shasum -a 256 "$archive" | cut -d' ' -f1)"
size="$(stat -f %z "$archive")"

cat > "$here/module.json" <<EOF
{
  "id": "browser-cef",
  "version": "$version",
  "url": "$base_url/$(basename "$archive")",
  "sha256": "$sha",
  "size": $size,
  "installDir": "browser-cef"
}
EOF

echo "archive:  $archive"
echo "sha256:   $sha"
echo "download: $size bytes"
echo "unpacked: $(du -sk "$stage" | cut -f1) KiB"
