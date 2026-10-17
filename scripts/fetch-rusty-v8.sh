#!/usr/bin/env bash
# Shallow-clone the pinned rusty_v8 (with V8 and its dependencies) into
# build/rusty_v8. Keep RUSTY_V8_TAG in step with the v8 crate version.
set -euo pipefail
cd "$(dirname "$0")/.."
RUSTY_V8_TAG=v152.2.0
if [ -d build/rusty_v8/.git ]; then
  echo "build/rusty_v8 already present"
  exit 0
fi
mkdir -p build
git clone -q --depth 1 --branch "$RUSTY_V8_TAG" --recurse-submodules --shallow-submodules \
  https://github.com/denoland/rusty_v8.git build/rusty_v8
echo "fetched rusty_v8 $RUSTY_V8_TAG"
