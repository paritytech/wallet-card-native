#!/bin/sh
# Builds the sample app for the iOS Simulator without an Xcode project and launches it on the booted
# simulator (or the first available iPhone). In a real app, add ../*.swift, ../../shaders/wallet.metal
# and ../../assets (as a folder reference named WalletAssets) to your target instead.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$HERE/../.."
APP="$HERE/.build/WalletDemo.app"; SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)
ARCH=$(uname -m); TARGET="$ARCH-apple-ios17.0-simulator"
rm -rf "$APP"; mkdir -p "$APP/WalletAssets"
xcrun -sdk iphonesimulator swiftc -parse-as-library -O -target "$TARGET" -sdk "$SDK" -o "$APP/WalletDemo" \
  "$HERE/WalletDemoApp.swift" "$ROOT/ios/WalletView.swift" "$ROOT/ios/WalletRenderer.swift" "$ROOT/ios/TiltSource.swift"
# precompile the shader when the Metal toolchain is installed; otherwise WalletView compiles the source at launch
xcrun -sdk iphonesimulator metal -target air64-apple-ios17.0-simulator -o "$APP/default.metallib" "$ROOT/shaders/wallet.metal" 2>/dev/null \
  || cp "$ROOT/shaders/wallet.metal" "$APP/WalletAssets/"
cp "$ROOT"/assets/* "$APP/WalletAssets/"
cat > "$APP/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>io.parity.walletdemo</string>
  <key>CFBundleExecutable</key><string>WalletDemo</string>
  <key>CFBundleName</key><string>WalletDemo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>MinimumOSVersion</key><string>17.0</string>
  <key>UIDeviceFamily</key><array><integer>1</integer></array>
  <key>UILaunchScreen</key><dict/>
  <key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationPortrait</string></array>
</dict></plist>
PLIST
codesign -s - "$APP" >/dev/null 2>&1 || true
DEV=$(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1)
if [ -z "$DEV" ]; then
  DEV=$(xcrun simctl list devices available | grep -E 'iPhone' | grep -oE '[0-9A-F-]{36}' | head -1)
  xcrun simctl boot "$DEV"
fi
xcrun simctl install "$DEV" "$APP"
xcrun simctl launch "$DEV" io.parity.walletdemo
echo "launched on $DEV"
