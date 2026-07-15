import { isIP } from "node:net";

export type ResolveHost = (hostname: string) => Promise<string[]>;

function unsafeIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4) return true;
  const [a = -1, b = -1] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function ipv6Words(address: string): number[] {
  let normalized = (address.toLowerCase().split("%")[0] ?? "");
  const dottedTail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    const octets = dottedTail.split(".").map(Number);
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    normalized = normalized.slice(0, -dottedTail.length) + `${high.toString(16)}:${low.toString(16)}`;
  }
  const sides = normalized.split("::");
  const left = sides[0] ? sides[0].split(":").filter(Boolean) : [];
  const right = sides[1] ? sides[1].split(":").filter(Boolean) : [];
  const zeroCount = sides.length === 2 ? 8 - left.length - right.length : 0;
  return [...left, ...Array.from({ length: zeroCount }, () => "0"), ...right].map((word) => Number.parseInt(word, 16));
}

function unsafeIpv6(address: string): boolean {
  const words = ipv6Words(address);
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = words;

  // Reject IPv4-compatible and IPv4-mapped forms altogether. Treating these
  // as IPv6 can otherwise bypass the IPv4 range checks in downstream clients.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0 || f === 0xffff)) return true;
  if ((a & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((a & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((a & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
  if ((a & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return true; // discard-only 100::/64
  if ((a & 0xe000) !== 0x2000) return true; // not globally routable 2000::/3 (also excludes NAT64 translation prefixes)
  if (a === 0x2001 && b === 0) return true; // Teredo 2001::/32
  if (a === 0x2002) return true; // 6to4 can tunnel to an embedded non-public IPv4 address
  if ((a & 0xfff0) === 0x3ff0) return true; // documentation 3fff::/20
  if (a === 0x2001 && b === 0x0db8) return true; // documentation 2001:db8::/32
  if (a === 0x2001 && b === 0x0002 && c === 0) return true; // benchmarking 2001:2::/48
  if (a === 0x2001 && ((b & 0xfff0) === 0x0010 || (b & 0xfff0) === 0x0020)) return true; // ORCHID
  return false;
}

export function isUnsafeAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return unsafeIpv4(address);
  if (kind === 6) return unsafeIpv6(address);
  return true;
}

export interface SafeRemoteUrl {
  url: URL;
  addresses: string[];
}

export async function resolveSafeRemoteUrl(raw: string, resolveHost: ResolveHost): Promise<SafeRemoteUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("unsafe URL: invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("unsafe URL protocol");
  }
  if (url.username || url.password) throw new Error("unsafe URL credentials");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname === "metadata.google.internal" || hostname.endsWith(".metadata.google.internal")) {
    throw new Error("unsafe metadata or loopback host");
  }
  const literalKind = isIP(hostname);
  const addresses = literalKind ? [hostname] : await resolveHost(hostname);
  if (addresses.length === 0 || addresses.some(isUnsafeAddress)) {
    throw new Error("unsafe resolved address");
  }
  return { url, addresses };
}

export async function assertSafeRemoteUrl(raw: string, resolveHost: ResolveHost): Promise<URL> {
  return (await resolveSafeRemoteUrl(raw, resolveHost)).url;
}
