#!/usr/bin/env bash
# Make a freshly fetched V8 checkout reuse a cached build. A fresh clone
# gives every source a new mtime, so ninja would rebuild all of V8. This
# backdates every source, then gives files that differ from the sources the
# cached build was made from (target/v8-sources.sha1) the current time, so
# ninja rebuilds exactly what changed. Without a manifest (no cache, or an
# older one) it leaves mtimes alone: a full rebuild, never a stale one.
# Run after restoring the cache, before building (Linux: GNU touch, sha1sum).
set -euo pipefail
cd "$(dirname "$0")/.."
manifest=target/v8-sources.sha1
new=$(mktemp)
(cd build/rusty_v8 && find . \( -name .git -o -path ./third_party/rust-toolchain \) -prune -o -type f -print0 \
  | sort -z | xargs -0 sha1sum) >"$new"
if [ -f "$manifest" ]; then
  changed=$(mktemp)
  comm -13 <(sort "$manifest") <(sort "$new") | cut -c43- >"$changed"
  find build/rusty_v8 -path build/rusty_v8/third_party/rust-toolchain -prune -o -exec touch -h -d '2000-01-01 00:00:00' {} +
  (cd build/rusty_v8 && tr '\n' '\0' <"$changed" | xargs -0 -r touch)
  echo "$(wc -l <"$changed") source files changed since the cached build"
else
  echo "no source manifest in the cache: full build"
fi
mkdir -p target
mv "$new" "$manifest"
