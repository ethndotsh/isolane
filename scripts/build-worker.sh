#!/usr/bin/env bash
# Build the worker with the web platform's startup snapshot embedded, in two
# passes: build it, have it write the snapshot (V8 can only make one by
# running), then build it again with the snapshot in ISOLANE_WEB_SNAPSHOT.
# The second pass recompiles only the worker crate and relinks.
#
#   scripts/build-worker.sh <profile> [cargo build args...]
#   scripts/build-worker.sh release                     # what build-v8.sh runs
#   scripts/build-worker.sh fast --no-default-features --features dev-prebuilt
#
# A worker built without this (plain cargo build) works the same, but builds
# the snapshot at startup (~30 ms before its first web isolate).
#
# Cross-compiling (CARGO_BUILD_TARGET set), the first pass's worker can't
# run here, so the snapshot is made on the target in between. CI builds
# linux-arm64 on x64 and makes its snapshot on an arm64 runner:
#   CARGO_BUILD_TARGET=aarch64-unknown-linux-gnu scripts/build-worker.sh release
#       builds without a snapshot (the first pass);
#   isolane-worker --make-web-snapshot=web-snapshot.bin    (on arm64)
#   ISOLANE_WEB_SNAPSHOT=web-snapshot.bin CARGO_BUILD_TARGET=... scripts/build-worker.sh release
#       builds again with it (the second pass).
set -euo pipefail
cd "$(dirname "$0")/.."

profile=${1:?usage: scripts/build-worker.sh <profile> [cargo build args...]}
shift
dir=target/${CARGO_BUILD_TARGET:+$CARGO_BUILD_TARGET/}$profile
[ "$profile" = dev ] && dir=${dir%/dev}/debug
host=$(rustc -vV | sed -n 's/^host: //p')
cross=; [ -n "${CARGO_BUILD_TARGET:-}" ] && [ "$CARGO_BUILD_TARGET" != "$host" ] && cross=1

if [ -n "${ISOLANE_WEB_SNAPSHOT:-}" ]; then
  # The second pass, with a snapshot made elsewhere.
  snapshot=$ISOLANE_WEB_SNAPSHOT
  cargo build --profile "$profile" -p isolane-worker "$@"
elif [ -n "$cross" ]; then
  # Pass 1 must not embed an old snapshot (it would be ignored anyway).
  ISOLANE_WEB_SNAPSHOT= cargo build --profile "$profile" -p isolane-worker "$@"
  echo "built $dir/isolane-worker for $CARGO_BUILD_TARGET without a snapshot: make one with it on the target, then build again with ISOLANE_WEB_SNAPSHOT"
  exit 0
else
  snapshot=$PWD/$dir/web-snapshot.bin
  ISOLANE_WEB_SNAPSHOT= cargo build --profile "$profile" -p isolane-worker "$@"
  "$dir/isolane-worker" --make-web-snapshot="$snapshot"
  ISOLANE_WEB_SNAPSHOT=$snapshot cargo build --profile "$profile" -p isolane-worker "$@"
fi
if [ -n "$cross" ]; then
  echo "built $dir/isolane-worker for $CARGO_BUILD_TARGET with the web snapshot ($(wc -c <"$snapshot" | tr -d ' ') bytes); --self-check on the target confirms it embedded"
  exit 0
fi
status=$("$dir/isolane-worker" --self-check | sed -n 's/.*"webSnapshot":"\([a-z]*\)".*/\1/p' || true)
if [ "$status" != embedded ]; then
  echo "build-worker.sh: the snapshot didn't embed (self-check says: ${status:-nothing})" >&2
  exit 1
fi
echo "built $dir/isolane-worker with the web snapshot embedded ($(wc -c <"$snapshot" | tr -d ' ') bytes)"
