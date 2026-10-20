#!/usr/bin/env bash
# Trace the worker across the test suite and list every syscall it makes
# after sending `ready` (the point where seccomp applies), with counts.
# Runs the worker with --no-lockdown so nothing is killed mid-trace.
# Usage: scripts/syscall-audit.sh path/to/isolane-worker
set -euo pipefail
cd "$(dirname "$0")/.."
worker=$(realpath "$1")
out=$(mktemp -d)
wrapper="$out/worker"
# Workers start with an empty environment, so use absolute paths.
cat >"$wrapper" <<WRAP
#!/bin/sh
mkdir -p "$out/\$\$"
exec $(command -v strace) -f -ff -tt -qq -o "$out/\$\$/t" "$worker" --no-lockdown
WRAP
chmod +x "$wrapper"
ISOLANE_WORKER="$wrapper" node --test $(ls test/*.test.mjs | grep -v lockdown) >"$out/tests.log" 2>&1 || true
python3 - "$out" <<'PY'
import collections, glob, os, re, sys
root = sys.argv[1]
counts = collections.Counter()
detail = collections.Counter()
prctls = collections.Counter()
line_re = re.compile(r'^(\d\d:\d\d:\d\d\.\d+) (?:<\.\.\. )?([a-z0-9_]+)[( ]')
for proc in glob.glob(os.path.join(root, '*/')):
    events = []
    for f in glob.glob(os.path.join(proc, 't.*')):
        for line in open(f, errors='replace'):
            m = line_re.match(line)
            if m:
                events.append((m.group(1), m.group(2), line))
    events.sort()
    # The ready frame is the first write to fd 1.
    ready = next((i for i, (_, name, line) in enumerate(events) if name == 'write' and line.split(' ', 1)[1].startswith('write(1,')), None)
    if ready is None:
        continue
    for _, name, line in events[ready + 1:]:
        if name not in ('exited', 'killed', 'resumed'):
            counts[name] += 1
        if name == 'prctl':
            args = line.split('prctl(', 1)[1].split(',')
            prctls[args[0].strip() + (':' + args[1].strip() if args[0].strip() == 'PR_SET_VMA' else '')] += 1
        if name in ('openat', 'open', 'ioctl', 'fstat', 'newfstatat', 'statx', 'prctl', 'clone'):
            call = line.split(' ', 1)[1].strip()
            detail[re.sub(r'0x[0-9a-f]+', '0x…', call.split(') = ')[0])[:120]] += 1
for name, n in sorted(counts.items(), key=lambda kv: -kv[1]):
    print(f'{n:9d} {name}')
print()
print('file, ioctl, prctl, and clone calls after ready:')
for call, n in detail.most_common(40):
    print(f'{n:9d} {call}')
# The gate: every syscall made after ready must be one the seccomp filter
# lets through (crates/worker/src/lockdown.rs), so a new one shows up here
# as a failure instead of as a SIGSYS kill in production. Traced without
# lockdown, file opens succeed, so the fstat and lseek that follow them
# are expected too (under lockdown the open fails first).
allowed = set(re.findall(r'libc::SYS_(\w+)', open('crates/worker/src/lockdown.rs').read()))
allowed |= {'fstat', 'lseek', 'restart_syscall'}
unexpected = sorted(set(counts) - allowed)
# prctl is allowed only for the options in PRCTL_ALLOWED (others get EPERM).
source = open('crates/worker/src/lockdown.rs').read()
block = source.split('PRCTL_ALLOWED: &[', 1)[1].split('];', 1)[0]
allowed_prctl = {o + (':' + sub if sub else '') for o, sub in re.findall(r'\(libc::(PR_\w+), (?:None|Some\(libc::(PR_\w+)\))\)', block)}
unexpected_prctl = sorted(set(prctls) - allowed_prctl)
print()
print('prctl options after ready: ' + ', '.join(f'{o} ({n})' for o, n in prctls.most_common()))
if unexpected:
    print('NOT ALLOWED by the seccomp filter: ' + ', '.join(unexpected))
if unexpected_prctl:
    print('prctl options NOT ALLOWED (they would get EPERM): ' + ', '.join(unexpected_prctl))
if unexpected or unexpected_prctl:
    sys.exit(1)
print('every syscall after ready is in the seccomp allowlist')
PY
