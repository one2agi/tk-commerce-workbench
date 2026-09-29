import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolveSafeRemoteUrl, type ResolveHost } from "@tk/domain/assets/validate-remote-url";

export interface AssetFetchResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array> | null;
}

export interface AssetFetchRequest {
  /** Original URL, retained for the HTTP request target and certificate checks. */
  url: string;
  /** Exact address returned by the validation lookup; clients must connect here. */
  connectAddress: string;
  /** HTTP Host header, including a non-default port. */
  hostHeader: string;
  /** TLS server name. Undefined for HTTP and IP-literal hosts. */
  servername?: string;
}

export type AssetFetch = (request: AssetFetchRequest) => Promise<AssetFetchResponse>;

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number
) => void;

function createPinnedLookup(address: string) {
  const family = isIP(address);
  if (family === 0) throw new Error("pinned lookup address must be an IP literal");
  return (
    _hostname: string,
    options: unknown,
    callback?: LookupCallback
  ) => {
    const cb = typeof options === "function" ? options as LookupCallback : callback;
    if (!cb) throw new Error("pinned lookup callback is required");
    const wantsAll = typeof options === "object" &&
      options !== null &&
      (options as { all?: boolean }).all === true;
    if (wantsAll) {
      cb(null, [{ address, family }]);
      return;
    }
    cb(null, address, family);
  };
}

export function createNodePinnedAssetFetch(timeoutMs = 30_000): AssetFetch {
  return (input) => new Promise((resolve, reject) => {
    const url = new URL(input.url);
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET",
      headers: { host: input.hostHeader, accept: "image/png,image/jpeg" },
      lookup: createPinnedLookup(input.connectAddress) as never,
      ...(input.servername ? { servername: input.servername } : {})
    }, (response) => {
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
      }
      resolve({ status: response.statusCode ?? 0, headers, body: response });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("asset download timeout")));
    request.on("error", reject);
    request.end();
  });
}

function imageType(contentType: string | undefined, pathname?: string): { extension: "jpg" | "png"; magicLength: number; validMagic: (bytes: Buffer) => boolean } {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "image/jpeg") {
    return { extension: "jpg", magicLength: 3, validMagic: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff };
  }
  if (normalized === "image/png") {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return { extension: "png", magicLength: signature.length, validMagic: (bytes) => bytes.subarray(0, signature.length).equals(signature) };
  }
  if (normalized === "application/octet-stream" || normalized === "binary/octet-stream") {
    const lowerPath = pathname?.toLowerCase() ?? "";
    if (lowerPath.endsWith(".png")) {
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      return { extension: "png", magicLength: signature.length, validMagic: (bytes) => bytes.subarray(0, signature.length).equals(signature) };
    }
    if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) {
      return { extension: "jpg", magicLength: 3, validMagic: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff };
    }
  }
  throw new Error("asset Content-Type must be image/png or image/jpeg");
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.byteLength < 24 || bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("PNG is missing a valid IHDR dimension header");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) throw new Error("PNG dimensions must be non-zero");
  return { width, height };
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf
]);

function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) break;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > bytes.byteLength) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      throw new Error("JPEG contains an invalid segment length");
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) throw new Error("JPEG SOF segment is too short");
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) throw new Error("JPEG dimensions must be non-zero");
      return { width, height };
    }
    offset += segmentLength;
  }
  throw new Error("JPEG is missing a supported SOF dimension marker");
}

function imageDimensions(extension: "jpg" | "png", bytes: Buffer): { width: number; height: number } {
  return extension === "png" ? pngDimensions(bytes) : jpegDimensions(bytes);
}

function header(response: AssetFetchResponse, name: string): string | undefined {
  const target = name.toLowerCase();
  const entry = Object.entries(response.headers).find(([key]) => key.toLowerCase() === target);
  return entry?.[1];
}

function localCanvasOutputAddress(url: URL): string | null {
  if (url.protocol !== "http:") return null;
  if (!url.pathname.startsWith("/assets/output/")) return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost") return "127.0.0.1";
  if (hostname === "::1") return "::1";
  if (/^127\./.test(hostname)) return hostname;
  return null;
}

export class ContentAddressedStore {
  private readonly maxRedirects: number;
  private readonly maxBytes: number;

  constructor(private readonly options: {
    assetRoot: string;
    fetch: AssetFetch;
    resolveHost: ResolveHost;
    maxRedirects?: number;
    maxBytes?: number;
  }) {
    this.maxRedirects = options.maxRedirects ?? 4;
    this.maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  }

  async archive(remoteUrl: string): Promise<{
    remoteUrl: string;
    finalUrl: string;
    sha256: string;
    path: string;
    extension: string;
    bytes: number;
    width: number;
    height: number;
  }> {
    await mkdir(this.options.assetRoot, { recursive: true });
    let current = new URL(remoteUrl);
    let response: AssetFetchResponse | undefined;

    for (let redirects = 0; redirects <= this.maxRedirects; redirects++) {
      const localCanvasAddress = localCanvasOutputAddress(current);
      const validated = localCanvasAddress
        ? { url: current, addresses: [localCanvasAddress] }
        : await resolveSafeRemoteUrl(current.toString(), this.options.resolveHost);
      current = validated.url;
      const hostname = current.hostname.replace(/^\[|\]$/g, "");
      response = await this.options.fetch({
        url: current.toString(),
        connectAddress: validated.addresses[0]!,
        hostHeader: current.host,
        ...(current.protocol === "https:" && isIP(hostname) === 0 ? { servername: hostname } : {})
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = header(response, "location");
      if (!location) throw new Error("redirect response is missing Location");
      if (redirects === this.maxRedirects) throw new Error("redirect limit exceeded");
      current = new URL(location, current);
    }

    if (!response || response.status < 200 || response.status >= 300 || !response.body) {
      throw new Error(`asset download failed with status ${response?.status ?? "unknown"}`);
    }

    const declaredLength = header(response, "content-length");
    if (declaredLength !== undefined) {
      const parsedLength = Number(declaredLength);
      if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > this.maxBytes) {
        throw new Error("asset response size exceeds limit");
      }
    }

    const type = imageType(header(response, "content-type"), current.pathname);
    const extension = type.extension;
    const temporaryPath = join(this.options.assetRoot, `.tmp-${randomUUID()}`);
    const hash = createHash("sha256");
    let bytes = 0;
    let prefix = Buffer.alloc(0);
    let magicValidated = false;
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      for await (const rawChunk of response.body) {
        const chunk = Buffer.from(rawChunk);
        bytes += chunk.byteLength;
        if (bytes > this.maxBytes) throw new Error("asset response size exceeds limit");
        if (!magicValidated) {
          const needed = type.magicLength - prefix.byteLength;
          prefix = Buffer.concat([prefix, chunk.subarray(0, Math.max(0, needed))]);
          if (prefix.byteLength >= type.magicLength) {
            if (!type.validMagic(prefix)) throw new Error("asset bytes do not match declared PNG/JPEG Content-Type");
            magicValidated = true;
          }
        }
        hash.update(chunk);
        await file.write(chunk);
      }
      if (!magicValidated) throw new Error("asset is too short to contain a valid PNG/JPEG signature");
      await file.sync();
      await file.close();

      const dimensions = imageDimensions(extension, await readFile(temporaryPath));

      const sha256 = hash.digest("hex");
      const bucket = join(this.options.assetRoot, sha256.slice(0, 2));
      const path = join(bucket, `${sha256}.${extension}`);
      await mkdir(bucket, { recursive: true });
      await rename(temporaryPath, path);
      const directory = await open(bucket, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return { remoteUrl, finalUrl: current.toString(), sha256, path, extension, bytes, ...dimensions };
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
