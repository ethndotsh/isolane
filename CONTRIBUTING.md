# Contributing to isolane

## Rust style

The worker's Rust follows
[Google's Rust style guide](https://google.github.io/styleguide/rustguide.html),
which builds on the official Rust Style Guide and the Rust API Guidelines.
The parts that suit a Cargo-built, stable-Rust project apply. The rules
marked for Chromium or Fuchsia only do not: the flat file layout, the bans
on `async` and on threads started through the standard library,
`chromium::import!`, and the gtest integration. The worker runs each VM on
its own thread, and its modules are nested by concern (`vm/`, `web/`,
`web/crypto/`).

Formatting is `cargo fmt` with the repository's `rustfmt.toml`, which sets
the guide's `max_width = 100`. The guide's other rustfmt settings
(`hex_literal_case`, `format_macro_matchers`, and
`imports_granularity = "Module"`) exist only in nightly rustfmt, and the
project builds with stable Rust, so they are not used. CI checks formatting
with `cargo fmt --check`.

The workspace's lints in `Cargo.toml` enforce the parts of the guide that
Clippy can check. Every `unsafe` block carries a `SAFETY:` comment
(`undocumented_unsafe_blocks`), panics name their reason with `expect`
rather than `unwrap` outside tests (`unwrap_used`), glob imports are
limited to `use super::*` in test modules (`wildcard_imports`), and string
concatenation uses `format!` (`string_add`). The guide's default-on lints
(`borrowed_box`, `ptr_arg`, `should_implement_trait`, `new_without_default`,
`wrong_self_convention`, `len_without_is_empty`) stay at their defaults. CI
runs `cargo clippy --all-targets -- -D warnings`, so any warning fails the
build.

The rest is a matter for review:

- Functions are called through their module (`js::throw_type`), and types
  are imported and used unqualified.
- A `bool` argument whose meaning isn't obvious at the call site gets an
  inline comment naming it (`Inflater::new(/* zlib_header */ true)`), or an
  enum when it is passed in many places.
- Values that cross module boundaries use named fields rather than tuples.
- A `let` bound to `.into()`, `.parse()`, or `.collect()` states its type.
- Each file opens with a `//!` comment saying what the module is for.
  Comments add what the code doesn't say; a comment that restates a
  function's name is left out.

The files under `crates/worker/src/web/crypto/` are ported from Deno's
`ext/crypto`. They keep Deno's copyright line and structure, and are
formatted and linted like the rest of the crate.
