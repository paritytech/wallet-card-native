#!/bin/sh
# Builds and runs the Metal reference renderer on macOS (Xcode command line tools).
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD="$ROOT/reference/metal/.build"
mkdir -p "$BUILD" "$ROOT/reference/results"
swiftc -O -o "$BUILD/render" "$ROOT/ios/WalletRenderer.swift" "$ROOT/reference/metal/main.swift"
"$BUILD/render" "$ROOT"
