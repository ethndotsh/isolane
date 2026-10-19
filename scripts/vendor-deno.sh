#!/usr/bin/env bash
# Copy the web-platform JS that isolane reuses from Deno (MIT) into
# runtime/deno/, at a pinned commit. These files implement WinterTC's
# Minimum Common Web Platform API on top of a small native layer; isolane
# provides that layer itself (crates/worker/src/web/ and runtime/core.js)
# instead of deno_core, so it keeps its own V8, lockdown, and clock.
# Re-run after changing DENO_COMMIT or FILES; review the diff like code.
set -euo pipefail
cd "$(dirname "$0")/.."
DENO_COMMIT=a18ce33715e30cd2b0d99c7e322ef11a65490e4d
FILES=(
  libs/core/00_primordials.js
  ext/webidl/00_webidl.js
  ext/web/00_infra.js
  ext/web/00_url.js
  ext/web/01_dom_exception.js
  ext/web/01_mimesniff.js
  ext/web/02_event.js
  ext/web/02_structured_clone.js
  ext/web/02_timers.js
  ext/web/03_abort_signal.js
  ext/web/04_global_interfaces.js
  ext/web/05_base64.js
  ext/web/06_streams.js
  ext/web/08_text_encoding.js
  ext/web/09_file.js
  ext/web/10_filereader.js
  ext/web/14_compression.js
  ext/web/15_performance.js
  ext/fetch/20_headers.js
  ext/fetch/21_formdata.js
  ext/fetch/22_body.js
  ext/fetch/23_request.js
  ext/fetch/23_response.js
)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git clone -q --filter=blob:none --no-checkout https://github.com/denoland/deno.git "$tmp/deno"
git -C "$tmp/deno" sparse-checkout set --no-cone LICENSE.md "${FILES[@]}"
git -C "$tmp/deno" checkout -q "$DENO_COMMIT"
rm -rf runtime/deno
for f in LICENSE.md "${FILES[@]}"; do
  mkdir -p "runtime/deno/$(dirname "$f")"
  cp "$tmp/deno/$f" "runtime/deno/$f"
done
echo "$DENO_COMMIT" >runtime/deno/COMMIT
echo "vendored ${#FILES[@]} files from denoland/deno@${DENO_COMMIT:0:12}"
