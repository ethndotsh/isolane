# Third-party code

| What | Where | License |
|---|---|---|
| Deno's web platform JavaScript (pinned by `scripts/vendor-deno.sh`; isolane's fixes in `patches/deno-*.patch`) | `runtime/deno/` | MIT, see `runtime/deno/LICENSE.md` |
| A patch to rusty_v8's platform bindings | `patches/rusty_v8-clock-platform.patch` | MIT (rusty_v8, Copyright the Deno authors) |
| V8, built from source into the worker binary | fetched by `scripts/fetch-rusty-v8.sh` | BSD-3-Clause (V8 project authors) |
| Rust crates the worker links (url, data-url, encoding_rs, flate2/miniz_oxide, brotli, sha2, serde, seccompiler, landlock, ...) | `Cargo.lock` | MIT and/or Apache-2.0 |

Web-platform-tests (WPT) is fetched at test time and isn't redistributed.
