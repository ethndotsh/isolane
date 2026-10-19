#!/usr/bin/env bash
# Shallow-clone the pinned rusty_v8 (with V8 and its dependencies) into
# build/rusty_v8, move its V8 to the pinned upstream patch release, then
# apply our patches (patches/rusty_v8-*.patch).
#
# RUSTY_V8_TAG: keep in step with the v8 crate version.
# V8_TAG: an upstream V8 release on the same branch as rusty_v8's V8.
#   rusty_v8 builds Deno's V8 fork (a few patches on top of an upstream
#   release) and rarely takes upstream's security backports, so we rebase
#   those patches onto the newest patch release ourselves.
#   .github/workflows/v8-update.yml bumps this daily.
set -euo pipefail
cd "$(dirname "$0")/.."
RUSTY_V8_TAG=v152.2.0
V8_TAG=15.2.124.1
UPSTREAM=https://chromium.googlesource.com/v8/v8.git
if [ -d build/rusty_v8/.git ]; then
  echo "build/rusty_v8 already present"
else
  mkdir -p build
  git clone -q --depth 1 --branch "$RUSTY_V8_TAG" --recurse-submodules --shallow-submodules \
    https://github.com/denoland/rusty_v8.git build/rusty_v8
  echo "fetched rusty_v8 $RUSTY_V8_TAG"
fi
v8_version() { # <git rev> -> V8 version at that commit
  git -C build/rusty_v8/v8 show "$1:include/v8-version.h" |
    sed -nE 's/^#define V8_(MAJOR_VERSION|MINOR_VERSION|BUILD_NUMBER|PATCH_LEVEL) ([0-9]+)/\2/p' | paste -sd. -
}
if [ "$(v8_version HEAD)" != "$V8_TAG" ]; then
  if ! git -C build/rusty_v8/v8 diff --quiet; then
    echo "build/rusty_v8/v8 has local changes; not moving it to $V8_TAG" >&2
    exit 1
  fi
  # Deno's fork as rusty_v8 pins it, and the upstream release it builds on.
  fork=$(git -C build/rusty_v8 ls-tree HEAD v8 | awk '{print $3}')
  git -C build/rusty_v8/v8 fetch -q --depth=50 origin "$fork"
  base=$(v8_version "$fork")
  git -C build/rusty_v8/v8 fetch -q --depth=1 "$UPSTREAM" "refs/tags/$base:refs/tags/$base" "refs/tags/$V8_TAG:refs/tags/$V8_TAG"
  git -C build/rusty_v8/v8 checkout -q --detach "$V8_TAG"
  git -C build/rusty_v8/v8 -c user.name=isolane -c user.email=isolane@localhost cherry-pick "$base..$fork" >/dev/null
  echo "rebased rusty_v8's V8 patches from $base onto $V8_TAG ($(git -C build/rusty_v8/v8 rev-list --count "$V8_TAG..HEAD") patches)"
fi

for p in "$PWD"/patches/rusty_v8-*.patch; do
  if git -C build/rusty_v8 apply --reverse --check "$p" 2>/dev/null; then
    continue # already applied
  fi
  git -C build/rusty_v8 apply "$p"
  echo "applied $(basename "$p")"
done
