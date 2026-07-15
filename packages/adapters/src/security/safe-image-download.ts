import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { externalFailure } from "@tk/contracts";

export type ResolvedAddress = Readonly<{ address: string; family: 4 | 6 }>;
export type ResolveHost = (host: string) => Promise<ResolvedAddress[]>;
type TransportResponse = Readonly<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
export type PinnedImageTransport = (url: URL, pinned: ResolvedAddress, timeoutMs: number, maxBytes: number) => Promise<TransportResponse>;

export interface SafeImageDownloadOptions {
  readonly resolveHost?: ResolveHost;
  readonly transport?: PinnedImageTransport;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
}

export function createSafeImageDownloader(options: SafeImageDownloadOptions = {}) {
  const resolveHost = options.resolveHost ?? resolvePublicAddresses;
  const transport = options.transport ?? nodePinnedTransport;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? 12 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;

  return async (input: string): Promise<{ bytes: Uint8Array; finalUrl: string }> => {
    let current = parseHttpUrl(input);
    for (let redirects = 0; ; redirects += 1) {
      const addresses = await resolveAndValidate(current, resolveHost);
      // The transport receives the validated address and pins socket DNS lookup to it. This
      // closes the validation-to-connect DNS rebinding window for every redirect hop.
      const result = await transport(current, addresses[0]!, timeoutMs, maxBytes);
      if (isRedirect(result.status)) {
        if (redirects >= maxRedirects) throw externalFailure("fatal", "download.too_many_redirects", "Remote image redirected too many times");
        const location = result.headers.location;
        if (!location) throw externalFailure("fatal", "download.invalid_redirect", "Remote image returned an invalid redirect");
        current = parseHttpUrl(new URL(location, current).toString());
        continue;
      }
      if (result.status < 200 || result.status >= 300) throw externalFailure("retryable", `download.http_${result.status}`, "Remote image download failed");
      const contentType = (result.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "image/png" && contentType !== "image/jpeg") {
        throw externalFailure("fatal", "download.invalid_content_type", "Remote file is not a supported image");
      }
      const declaredLength = Number(result.headers["content-length"] ?? 0);
      if ((Number.isFinite(declaredLength) && declaredLength > maxBytes) || result.body.byteLength > maxBytes) {
        throw externalFailure("fatal", "download.too_large", "Remote image exceeds the size limit");
      }
      return Object.freeze({ bytes: result.body, finalUrl: current.toString() });
    }
  };
}

/** Validates a URL host without downloading it. Used before handing URLs to remote workers. */
export async function assertPublicHttpUrl(value: string, resolveHost: ResolveHost = resolvePublicAddresses): Promise<void> {
  const url = parseHttpUrl(value);
  await resolveAndValidate(url, resolveHost);
}

async function resolveAndValidate(url: URL, resolveHost: ResolveHost): Promise<ResolvedAddress[]> {
  const host = normalizeIpLiteral(url.hostname).toLowerCase().replace(/\.$/, "");
  if (host === "metadata.google.internal" || host === "metadata.azure.internal" || host === "instance-data") {
    throw externalFailure("fatal", "download.blocked_address", "Remote image address is not publicly routable");
  }
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) as 4 | 6 }]
    : await resolveHost(host);
  if (addresses.length === 0 || addresses.some((entry) => !isPublicIp(entry.address))) {
    throw externalFailure("fatal", "download.blocked_address", "Remote image address is not publicly routable");
  }
  return addresses;
}

async function resolvePublicAddresses(host: string): Promise<ResolvedAddress[]> {
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
  } catch {
    throw externalFailure("retryable", "download.dns_failed", "Remote image host could not be resolved");
  }
}

function nodePinnedTransport(url: URL, pinned: ResolvedAddress, timeoutMs: number, maxBytes: number): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = client(url, {
      method: "GET",
      headers: { accept: "image/png,image/jpeg" },
      lookup: ((_host: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => callback(null, pinned.address, pinned.family)) as never
    }, (response) => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > maxBytes) {
          request.destroy(new Error("download body too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value[0] ?? "" : value;
        resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("download timeout")));
    request.on("error", (error) => reject(error.message === "download body too large" ? externalFailure("fatal", "download.too_large", "Remote image exceeds the size limit") : isExternalFailure(error) ? error : externalFailure("retryable", "download.network", "Remote image is temporarily unavailable")));
    request.end();
  });
}

function parseHttpUrl(value: string): URL {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error("invalid");
    return url;
  } catch {
    throw externalFailure("fatal", "download.invalid_url", "Remote image URL is invalid");
  }
}

function normalizeIpLiteral(value: string): string {
  return value.replace(/^\[|\]$/g, "");
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isPublicIp(raw: string): boolean {
  const address = normalizeIpLiteral(raw).toLowerCase();
  if (address.startsWith("::ffff:")) return isPublicIp(address.slice(7));
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    const [a, b] = octets;
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a! >= 224);
  }
  if (isIP(address) === 6) {
    return !(address === "::" || address === "::1" || /^f[cd]/.test(address) || /^fe[89ab]/.test(address) || /^ff/.test(address));
  }
  return false;
}

function isExternalFailure(error: unknown): error is { kind: string; code: string; safeMessage: string } {
  return Boolean(error && typeof error === "object" && "kind" in error && "code" in error && "safeMessage" in error);
}
