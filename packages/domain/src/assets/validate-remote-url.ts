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

function unsafeIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mapped ? unsafeIpv4(mapped) : false;
}

export function isUnsafeAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return unsafeIpv4(address);
  if (kind === 6) return unsafeIpv6(address);
  return true;
}

export async function assertSafeRemoteUrl(raw: string, resolveHost: ResolveHost): Promise<URL> {
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
  return url;
}
