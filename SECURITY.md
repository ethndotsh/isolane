# Security

isolane exists to run untrusted code, so security reports are the most
valuable contribution there is.

**Status: not ready for untrusted code in production.** The design's security
gate (an external review, a fuzzing program, a written threat-model
sign-off) hasn't been met yet. See `docs/design.md` for the threat model and
`docs/roadmap.md` for where things stand.

## Release gate

What has to be true before isolane is recommended for untrusted code in
production, from the October 2026 external review's conditions for
approval. `docs/roadmap.md` (section 1, "Security review, October 2026")
has the details and is kept current.

| Condition | Status |
|---|---|
| A tagged release commit, and the exact Linux x64 worker built from it | open: no release yet (`release.yml` builds and publishes from a tag) |
| A green suite, with the `fetch` port policy proven through the guest's own `fetch` | done |
| The escape probes, fd check, and syscall-audit gate run against the release worker on bare metal and in a container/Kubernetes profile | partly: CI runs them against the release worker on GitHub's Linux VMs; bare metal and Kubernetes not yet |
| Fuzzilli against the release embedding, an external review sign-off, and a written acceptance of the residual risks | open |
| `fs` writes confined against symlink races (`openat2`/dirfd), or a rule that `fs.write` never covers code or executables | open |
| A tenant's isolates aren't separate security domains | decided: the tenant is the boundary (`docs/design.md`) |
| Recovery after a compromise: worker recycling (max lifetime, max requests), ideally a `--jitless` quarantine worker | open |
| A tenant-wide background CPU budget, or the per-isolate one accepted | done: `limits.workerBackgroundMs` |
| CPU accounting the worker can't forge, or `usage()` documented as advisory | partly: documented as advisory |
| `prctl` narrowed; byte limits for `fs`, `connect`, and `fetch`; `x448` and `paste` resolved or accepted | partly: `prctl` narrowed, `fs.limits.writtenBytes` added, `paste` accepted and `x448` pinned (`.cargo/audit.toml`); `connect` bytes and a default for `fetch.limits.requests` open |
| `docs/design.md` describes what's built; README and this file keep saying "not ready" until the rest is closed | done |

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a
vulnerability** on this repository. Don't open a public issue for anything
that could let guest code escape its sandbox, read another tenant's data,
reach the host, or deny service to other tenants.

Include what you can: the isolane commit, the host OS and kernel, the guest
code or steps, and what you observed. We'll acknowledge reports promptly and
coordinate a fix and disclosure with you.

## Scope

In scope: escapes from the worker's lockdown (seccomp, Landlock), the V8
sandbox as configured here, cross-tenant access, policy bypasses (network,
sockets, fs), the supervisor trusting worker output, limit bypasses that
affect other tenants or the host.

V8 bugs themselves belong upstream at <https://g.co/chrome/vrp>; tell us too
if isolane's configuration makes one reachable or worse.
