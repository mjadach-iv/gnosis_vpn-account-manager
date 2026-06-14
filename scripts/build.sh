#!/usr/bin/env bash
# Build standalone gvpn-accounts binaries.
#
# Pipeline: esbuild bundles all ESM source + dependencies into a single CJS
# file (dist/index.cjs), then @yao-pkg/pkg packages that bundle into native
# executables (one per target) under dist/bin/.
#
# The .env (MySQL creds + ENCRYPTION_KEY) is baked into each binary at build
# time: creds encrypted with the key, key XOR-obfuscated (see src/embed.js).
# A built binary is self-contained and ignores any runtime .env. Override the
# source .env with GVPN_ENV_FILE=path.
#
# Usage:
#   scripts/build.sh                # all targets in package.json "pkg".targets
#   scripts/build.sh host           # only the current platform/arch
#   scripts/build.sh node22-linux-x64 node22-macos-arm64   # explicit targets

set -euo pipefail
cd "$(dirname "$0")/.."

NODE_BASE="node22"
OUT_DIR="dist/bin"
ENV_FILE="${GVPN_ENV_FILE:-.env}"

# Map a pkg target triple to a friendly binary filename.
bin_name() {
  case "$1" in
    *linux-x64*)   echo "gvpn-accounts-linux-x64" ;;
    *linux-arm64*) echo "gvpn-accounts-linux-arm64" ;;
    *macos-arm64*) echo "gvpn-accounts-macos-arm64" ;;
    *)             echo "gvpn-accounts-$1" ;;
  esac
}

# Resolve the pkg target for the current host (used by the "host" shortcut).
host_target() {
  local os arch
  case "$(uname -s)" in
    Linux)  os="linux" ;;
    Darwin) os="macos" ;;
    *) echo "Unsupported host OS: $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) echo "Unsupported host arch: $(uname -m)" >&2; exit 1 ;;
  esac
  echo "${NODE_BASE}-${os}-${arch}"
}

# Determine the target list.
if [ "$#" -eq 0 ]; then
  TARGETS=("node22-linux-x64" "node22-linux-arm64" "node22-macos-arm64")
elif [ "$1" = "host" ]; then
  TARGETS=("$(host_target)")
else
  TARGETS=("$@")
fi

echo "==> Cleaning dist/"
rm -rf dist
mkdir -p "$OUT_DIR"

echo "==> Embedding config from $ENV_FILE"
EMBEDDED="$(node scripts/embed-config.mjs "$ENV_FILE")"

echo "==> Bundling with esbuild (config baked in)"
npx esbuild src/index.js \
  --bundle \
  --platform=node \
  --target="$NODE_BASE" \
  --format=cjs \
  --define:__EMBEDDED_CONFIG__="\"$EMBEDDED\"" \
  --outfile=dist/index.cjs

echo "==> Packaging binaries with pkg"
for target in "${TARGETS[@]}"; do
  out="$OUT_DIR/$(bin_name "$target")"
  echo "    - $target -> $out"
  npx pkg dist/index.cjs --targets "$target" --output "$out"
done

echo "==> Done. Binaries in $OUT_DIR:"
ls -lh "$OUT_DIR"
