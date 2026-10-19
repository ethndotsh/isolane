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
V8_TAG=15.2.124.45
# The commits those tags name, checked after fetching: a tag that moved
# fails the build instead of building other code.
RUSTY_V8_COMMIT=2768994f664e8a6e3aba27503606c58339136e2a
V8_COMMIT=e51a6bf02e52f3dec9fee502db2594c0f5f51b37
UPSTREAM=https://chromium.googlesource.com/v8/v8.git

# Git hosts (Chromium's especially) return transient 5xx errors; retry with
# backoff rather than failing a run.
retry() {
  local n
  for n in 1 2 3 4 5; do
    "$@" && return 0
    echo "failed (attempt $n): $*; retrying in $((n * 20))s" >&2
    sleep $((n * 20))
  done
  return 1
}
if [ -d build/rusty_v8/.git ]; then
  echo "build/rusty_v8 already present"
else
  mkdir -p build
  clone() {
    rm -rf build/rusty_v8.partial
    git clone -q --depth 1 --branch "$RUSTY_V8_TAG" --recurse-submodules --shallow-submodules \
      https://github.com/denoland/rusty_v8.git build/rusty_v8.partial
  }
  retry clone
  mv build/rusty_v8.partial build/rusty_v8
  echo "fetched rusty_v8 $RUSTY_V8_TAG"
fi
if [ "$(git -C build/rusty_v8 rev-parse HEAD)" != "$RUSTY_V8_COMMIT" ]; then
  echo "rusty_v8 $RUSTY_V8_TAG is $(git -C build/rusty_v8 rev-parse HEAD), not the pinned $RUSTY_V8_COMMIT" >&2
  exit 1
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
  retry git -C build/rusty_v8/v8 fetch -q --depth=50 origin "$fork"
  base=$(v8_version "$fork")
  retry git -C build/rusty_v8/v8 fetch -q --depth=1 "$UPSTREAM" "refs/tags/$base:refs/tags/$base" "refs/tags/$V8_TAG:refs/tags/$V8_TAG"
  git -C build/rusty_v8/v8 checkout -q --detach "$V8_TAG"
  git -C build/rusty_v8/v8 -c user.name=isolane -c user.email=isolane@localhost cherry-pick "$base..$fork" >/dev/null
  echo "rebased rusty_v8's V8 patches from $base onto $V8_TAG ($(git -C build/rusty_v8/v8 rev-list --count "$V8_TAG..HEAD") patches)"
fi
if ! git -C build/rusty_v8/v8 merge-base --is-ancestor "$V8_COMMIT" HEAD 2>/dev/null ||
  [ "$(git -C build/rusty_v8/v8 rev-parse "refs/tags/$V8_TAG^{commit}" 2>/dev/null || echo "$V8_COMMIT")" != "$V8_COMMIT" ]; then
  echo "V8 $V8_TAG isn't the pinned $V8_COMMIT" >&2
  exit 1
fi

for p in "$PWD"/patches/rusty_v8-*.patch; do
  if git -C build/rusty_v8 apply --reverse --check "$p" 2>/dev/null; then
    continue # already applied
  fi
  git -C build/rusty_v8 apply "$p"
  echo "applied $(basename "$p")"
done
