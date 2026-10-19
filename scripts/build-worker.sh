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
# Cross-compiling: the first pass's binary must run on the build machine.
# For a target it can't run (arm64 from x64), build on a native runner,
# run the first pass under qemu-user, or ship without an embedded snapshot.
set -euo pipefail
cd "$(dirname "$0")/.."

profile=${1:?usage: scripts/build-worker.sh <profile> [cargo build args...]}
shift
dir=target/$profile
[ "$profile" = dev ] && dir=target/debug
snapshot=$PWD/$dir/web-snapshot.bin

# Pass 1 must not embed an old snapshot (it would be ignored anyway).
ISOLANE_WEB_SNAPSHOT= cargo build --profile "$profile" -p isolane-worker "$@"
"$dir/isolane-worker" --make-web-snapshot="$snapshot"
ISOLANE_WEB_SNAPSHOT=$snapshot cargo build --profile "$profile" -p isolane-worker "$@"
status=$("$dir/isolane-worker" --self-check | sed -n 's/.*"webSnapshot":"\([a-z]*\)".*/\1/p' || true)
if [ "$status" != embedded ]; then
  echo "build-worker.sh: the snapshot didn't embed (self-check says: ${status:-nothing})" >&2
  exit 1
fi
echo "built $dir/isolane-worker with the web snapshot embedded ($(wc -c <"$snapshot" | tr -d ' ') bytes)"
