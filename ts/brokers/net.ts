// What the network brokers share: which addresses are public, a DNS lookup
// pinned to the ones the policy allows, host patterns, and how a refused
// URL is reported.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/** A broker operation, as a host function (guest arguments, any shape). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BrokerFunction = (...args: any[]) => unknown;

/** How a broker reports to the isolate's hooks: a refused target
 * (`onPolicyDenial`), or a policy limit reached (`onLimit`, with the
 * limit's config path, such as `fetch.limits.requests`). */
export interface BrokerReporter {
  denied(api: 'fetch' | 'connect' | 'fs', target: string, reason: string): void;
  limit(name: string, message: string): void;
}

export const NO_REPORTER: BrokerReporter = { denied: () => {}, limit: () => {} };

export const MiB = 1 << 20;

// Separate lists: a BlockList also checks IPv4 addresses against IPv6 rules
// (as IPv4-mapped), and ::ffff:0:0/96 would then match every IPv4 address.
const NON_PUBLIC_V4 = new BlockList();
const NON_PUBLIC_V6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC_V4.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback, IPv4-compatible
  ['::ffff:0:0', 96], // IPv4-mapped
  ['::ffff:0:0:0', 96], // IPv4-translated
  ['64:ff9b::', 96], // NAT64 (well-known prefix)
  ['64:ff9b:1::', 48], // NAT64 (local-use)
  ['100::', 64], // discard-only
  // Transition and special-purpose space: Teredo (2001::/32), benchmarking,
  // ORCHID. Teredo and 6to4 addresses embed an IPv4 address, which a host
  // with a relay route would reach (2002:7f00:1:: is 127.0.0.1).
  ['2001::', 23],
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation
  ['5f00::', 16], // SRv6 SIDs
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  NON_PUBLIC_V6.addSubnet(net, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return family === 4 ? !NON_PUBLIC_V4.check(address, 'ipv4') : !NON_PUBLIC_V6.check(address, 'ipv6');
}

type LookupCallback = (err: Error | null, address: string | LookupAddress[], family?: number) => void;

/** A `lookup` for http/net/tls that only returns addresses the policy
 * allows, so the address checked is the address connected to. `refused`
 * hears when a name resolves only to addresses it doesn't. */
export function pinnedLookup(allowPrivate: boolean, refused: () => void) {
  return (hostname: string, options: { family?: number | string; all?: boolean }, cb: LookupCallback) => {
    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : Number(options.family) || 0;
    dnsLookup(hostname, { all: true, family }, (err, addresses) => {
      if (err) return cb(err, []);
      const usable = allowPrivate ? addresses : addresses.filter((a) => isPublicAddress(a.address));
      if (usable.length === 0) {
        refused();
        return cb(new Error(`${hostname} has no public address`), []);
      }
      if (options.all) cb(null, usable);
      else cb(null, usable[0].address, usable[0].family);
    });
  };
}

/**
 * Does a host pattern allow `host` (lowercase, IPv6 without brackets) on
 * `port`? Patterns are exact (`api.example.com`) or any subdomain
 * (`*.example.com`), with a port (`host:8443`, `[2001:db8::1]:80`) or any
 * port (`host:*`). A pattern without one allows only `defaultPort` (fetch:
 * the scheme's), or nothing if there's none (connect names every port).
 */
export function matchHost(patterns: readonly string[], host: string, port: number, defaultPort?: number): boolean {
  return patterns.some((p) => {
    let pattern = p.toLowerCase();
    let portPattern: string | undefined;
    const bracket = /^\[([^\]]+)\](?::(.*))?$/.exec(pattern);
    if (bracket) [, pattern, portPattern] = bracket;
    else if (pattern.indexOf(':') !== -1 && pattern.indexOf(':') === pattern.lastIndexOf(':')) [pattern, portPattern] = pattern.split(':');
    if (portPattern === undefined ? port !== defaultPort : portPattern !== '*' && Number(portPattern) !== port) return false;
    return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern;
  });
}

/** A URL for `onPolicyDenial`, without any `user:password@` in it (the guest's credentials). */
export function redacted(url: unknown): string {
  let u: URL;
  try {
    u = url instanceof URL ? new URL(url.href) : new URL(String(url ?? ''));
  } catch {
    return String(url ?? '').slice(0, 200).replace(/\/\/[^/@]*@/, '//');
  }
  u.username = '';
  u.password = '';
  return u.href;
}
