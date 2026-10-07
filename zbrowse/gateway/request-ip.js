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

  const candidate = chain[chain.length - hops];
  return isIP(candidate) ? candidate : socketIp;
}
