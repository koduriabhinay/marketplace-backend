import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * SSRF protection. A webhook URL is chosen by a user, and our worker will make a request
 * to it from inside our network. Without checks, a seller could register
 * http://169.254.169.254/ (the cloud metadata service, which hands out credentials) or
 * http://localhost:5432 and make us attack ourselves.
 *
 * So, before every delivery, we resolve the hostname and refuse private, loopback,
 * link-local and other internal ranges. Redirects are not followed (a public URL could
 * redirect to an internal one).
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, including cloud metadata endpoints
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3], // multicast and reserved
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) {
    // IPv4-mapped IPv6 (::ffff:10.0.0.1) must be checked as IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return blocked.check(mapped[1]!, 'ipv4');
    return blocked.check(ip, 'ipv6');
  }
  return true; // not an IP at all: refuse
}

export class UnsafeUrlError extends Error {
  override name = 'UnsafeUrlError';
}

/** Checks the URL's shape. Used when a seller registers an endpoint. */
export function assertWebhookUrlShape(raw: string, allowInsecure: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('Webhook URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
    throw new UnsafeUrlError('Webhook URL must use https');
  }
  if (url.username || url.password) throw new UnsafeUrlError('Webhook URL must not contain credentials');
  return url;
}

/** Full check right before sending: shape, then every address the hostname resolves to. */
export async function assertDeliverableUrl(raw: string, allowInsecure: boolean): Promise<URL> {
  const url = assertWebhookUrlShape(raw, allowInsecure);
  if (allowInsecure) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new UnsafeUrlError(`Webhook host ${url.hostname} resolves to a private or reserved address`);
  }
  return url;
}
