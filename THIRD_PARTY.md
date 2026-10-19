# Third-party code

| What | Where | License |
|---|---|---|
| Deno's web platform JavaScript (pinned by `scripts/vendor-deno.sh`; isolane's fixes in `patches/deno-*.patch`) | `runtime/deno/` | MIT, see `runtime/deno/LICENSE.md` |
| A patch to rusty_v8's platform bindings | `patches/rusty_v8-clock-platform.patch` | MIT (rusty_v8, Copyright the Deno authors) |
| V8, built from source into the worker binary | fetched by `scripts/fetch-rusty-v8.sh` | BSD-3-Clause (V8 project authors) |
| Deno's WebCrypto ops (ext/crypto, Rust), ported to isolane's native layer | `crates/worker/src/web/crypto/` | MIT (Copyright the Deno authors) |
| Rust crates the worker links (url, data-url, encoding_rs, flate2/miniz_oxide, brotli, serde, seccompiler, landlock, RustCrypto's aes, aes-gcm, ghash, sha1/2/3, hmac, hkdf, rsa, p256/p384/p521, x448, ..., deno_error) | `Cargo.lock` | MIT and/or Apache-2.0 |
| The dalek curve crates (curve25519-dalek, ed25519-dalek, x25519-dalek) and subtle | `Cargo.lock` | BSD-3-Clause |

Web-platform-tests (WPT) is fetched at test time and isn't redistributed.
