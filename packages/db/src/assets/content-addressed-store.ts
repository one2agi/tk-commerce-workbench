import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
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

export function createNodePinnedAssetFetch(timeoutMs = 30_000): AssetFetch {
  return (input) => new Promise((resolve, reject) => {
    const url = new URL(input.url);
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET",
      headers: { host: input.hostHeader, accept: "image/png,image/jpeg" },
      lookup: ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
        callback(null, input.connectAddress, isIP(input.connectAddress));
      }) as never,
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

function imageType(contentType: string | undefined): { extension: "jpg" | "png"; magicLength: number; validMagic: (bytes: Buffer) => boolean } {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "image/jpeg") {
    return { extension: "jpg", magicLength: 3, validMagic: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff };
  }
  if (normalized === "image/png") {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return { extension: "png", magicLength: signature.length, validMagic: (bytes) => bytes.subarray(0, signature.length).equals(signature) };
  }
  throw new Error("asset Content-Type must be image/png or image/jpeg");
}

function header(response: AssetFetchResponse, name: string): string | undefined {
  const target = name.toLowerCase();
  const entry = Object.entries(response.headers).find(([key]) => key.toLowerCase() === target);
  return entry?.[1];
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
  }> {
    await mkdir(this.options.assetRoot, { recursive: true });
    let current = new URL(remoteUrl);
    let response: AssetFetchResponse | undefined;

    for (let redirects = 0; redirects <= this.maxRedirects; redirects++) {
      const validated = await resolveSafeRemoteUrl(current.toString(), this.options.resolveHost);
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

    const type = imageType(header(response, "content-type"));
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
      return { remoteUrl, finalUrl: current.toString(), sha256, path, extension, bytes };
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
