#!/usr/bin/env bash
# Shallow-clone the pinned rusty_v8 (with V8 and its dependencies) into
# build/rusty_v8, then apply our patches (patches/rusty_v8-*.patch).
# Keep RUSTY_V8_TAG in step with the v8 crate version.
set -euo pipefail
cd "$(dirname "$0")/.."
RUSTY_V8_TAG=v152.2.0
if [ -d build/rusty_v8/.git ]; then
  echo "build/rusty_v8 already present"
else
  mkdir -p build
  git clone -q --depth 1 --branch "$RUSTY_V8_TAG" --recurse-submodules --shallow-submodules \
    https://github.com/denoland/rusty_v8.git build/rusty_v8
  echo "fetched rusty_v8 $RUSTY_V8_TAG"
fi
for p in "$PWD"/patches/rusty_v8-*.patch; do
  if git -C build/rusty_v8 apply --reverse --check "$p" 2>/dev/null; then
    continue # already applied
  fi
  git -C build/rusty_v8 apply "$p"
  echo "applied $(basename "$p")"
done
