#!/usr/bin/env bash
# Print the extra GN args for V8 (scripts/v8.gn without comments), as one
# line: the value of GN_ARGS for every cargo build of the worker.
set -euo pipefail
cd "$(dirname "$0")/.."
grep -v '^\s*#' scripts/v8.gn | grep -v '^\s*$' | tr '\n' ' ' | sed 's/ $//'
