#!/usr/bin/env bash
# Build the worker with V8 compiled from source, V8 sandbox enabled.
# rusty_v8 publishes no prebuilt with v8_enable_sandbox, so every target
# builds V8 itself. Expects the rusty_v8 checkout at build/rusty_v8.
# Logs to build/logs/<os>-<arch>.log.
set -euo pipefail
cd "$(dirname "$0")/.."

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
log="build/logs/${os}-${arch}.log"
mkdir -p build/logs

if [ "$os" = darwin ]; then
  # Chromium's GN build probes the SDK through full Xcode (xcodebuild,
  # Platforms/), which the Command Line Tools alone don't provide.
  if ! xcodebuild -version >/dev/null 2>&1; then
    echo "building V8 on macOS needs full Xcode (not just the Command Line Tools):" >&2
    echo "install it, then: sudo xcode-select -s /Applications/Xcode.app" >&2
    exit 1
  fi
  # python.org Pythons ship without a CA bundle; use the system one.
  if ! python3 -c 'import urllib.request; urllib.request.urlopen("https://storage.googleapis.com/chromium-browser-clang/", timeout=10)' 2>/dev/null; then
    export SSL_CERT_FILE=/etc/ssl/cert.pem
  fi
fi

if [ "$os" = linux ] && [ -z "${LIBCLANG_PATH:-}" ]; then
  # rusty_v8 runs bindgen against the bundled libc++, which needs libclang 21+
  # (distro libclang is usually older). apt.llvm.org: ./llvm.sh 21 &&
  # apt-get install libclang-21-dev
  if [ -d /usr/lib/llvm-21/lib ]; then
    export LIBCLANG_PATH=/usr/lib/llvm-21/lib
    # Make bindgen use clang 21's builtin headers too, not another
    # installed clang's.
    export CLANG_PATH="${CLANG_PATH:-/usr/lib/llvm-21/bin/clang}"
  else
    echo "building V8 on Linux needs libclang 21 (apt.llvm.org: llvm.sh 21, then libclang-21-dev)" >&2
    exit 1
  fi
fi

# Extra GN args, one per line (comments allowed).
GN_ARGS="${GN_ARGS:-} $(grep -v '^\s*#' scripts/v8.gn | tr '\n' ' ')"
export GN_ARGS

start=$(date +%s)
if V8_FROM_SOURCE=1 cargo build --release -p isolane-worker -vv >"$log" 2>&1; then
  echo "built in $(( $(date +%s) - start ))s; log: $log"
else
  echo "build failed after $(( $(date +%s) - start ))s; log: $log" >&2
  grep -nE 'ERROR at|FAILED:|error: failed to run|panicked' "$log" | head -10 >&2 || true
  exit 1
fi
