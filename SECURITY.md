# Security

isolane exists to run untrusted code, so security reports are the most
valuable contribution there is.

**Status: not ready for untrusted code in production.** The design's security
gate (an external review, a fuzzing program, a written threat-model
sign-off) hasn't been met yet. See `docs/design.md` for the threat model and
`docs/roadmap.md` for where things stand.

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
