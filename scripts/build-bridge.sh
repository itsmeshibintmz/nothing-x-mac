#!/bin/sh
# Builds the Swift Bluetooth helper (native/mac/NXBridge.swift) into build/.
#
#   scripts/build-bridge.sh             for this Mac's chip (development)
#   scripts/build-bridge.sh universal   Apple Silicon + Intel (release)
#
# Tauri bundles it as a sidecar and expects one file per Rust target triple:
# build/nx-bridge-<triple>. A universal build writes all three names.
set -eu

cd "$(dirname "$0")/.."
mkdir -p build

MIN_MACOS=13
SRC=native/mac/NXBridge.swift
PLIST=native/mac/Info.plist

# The Info.plist (Bluetooth usage text) is embedded in the binary.
compile() { # <swift arch> <output>
  swiftc -O -target "$1-apple-macos$MIN_MACOS" -framework IOBluetooth \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PLIST" \
    "$SRC" -o "$2"
}

if [ "${1:-}" = "universal" ]; then
  compile arm64 build/nx-bridge-arm64
  compile x86_64 build/nx-bridge-x86_64
  lipo -create build/nx-bridge-arm64 build/nx-bridge-x86_64 -output build/nx-bridge-universal-apple-darwin
  rm build/nx-bridge-arm64 build/nx-bridge-x86_64
  cp build/nx-bridge-universal-apple-darwin build/nx-bridge-aarch64-apple-darwin
  cp build/nx-bridge-universal-apple-darwin build/nx-bridge-x86_64-apple-darwin
  echo "Built build/nx-bridge-universal-apple-darwin ($(lipo -archs build/nx-bridge-universal-apple-darwin))"
else
  case "$(uname -m)" in
    arm64) compile arm64 build/nx-bridge-aarch64-apple-darwin ;;
    *) compile x86_64 build/nx-bridge-x86_64-apple-darwin ;;
  esac
  echo "Built the Bluetooth helper for $(uname -m)"
fi
