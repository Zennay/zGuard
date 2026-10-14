import { isIP } from 'node:net';

export function requestIp(req, trustedProxyHops = 1) {
  const socketIp = req?.socket?.remoteAddress || '';
  const hops = Number.isInteger(trustedProxyHops) && trustedProxyHops > 0
    ? trustedProxyHops
    : 0;

  if (hops === 0) return socketIp;

  const header = req?.headers?.['x-forwarded-for'];
  const forwarded = Array.isArray(header) ? header.join(',') : header;
  if (typeof forwarded !== 'string' || !forwarded.trim()) return socketIp;

  const chain = forwarded
    .split(',')
    .map((value) => value.trim());

  if (chain.some((value) => !value) || chain.length < hops) return socketIp;

  // The selected client address is only trustworthy if the entire configured
  // right-side proxy chain is valid. A malformed intermediary must not be
  // used to legitimize an attacker-controlled client further to its left.
  // Scoped IPv6 zone identifiers are not portable client identities: Node's
  // net.isIP() accepts them, but rate limiters and proxies may key differently.
  const trustedChain = chain.slice(-hops);
  if (trustedChain.some((value) => !isIP(value) || value.includes('%'))) {
    return socketIp;
  }
  return trustedChain[0];
}
