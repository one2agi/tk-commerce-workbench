import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeRemoteUrl, type ResolveHost } from "@tk/domain/assets/validate-remote-url";

export interface AssetFetchResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array> | null;
}

export type AssetFetch = (url: string) => Promise<AssetFetchResponse>;

function extensionFor(contentType: string | undefined, url: URL): string {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const byType: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif"
  };
  if (normalized && byType[normalized]) return byType[normalized];
  const match = url.pathname.toLowerCase().match(/\.(jpe?g|png|webp|gif|avif)$/)?.[1];
  return match === "jpeg" ? "jpg" : match ?? "bin";
}

function header(response: AssetFetchResponse, name: string): string | undefined {
  const target = name.toLowerCase();
  const entry = Object.entries(response.headers).find(([key]) => key.toLowerCase() === target);
  return entry?.[1];
}

export class ContentAddressedStore {
  private readonly maxRedirects: number;

  constructor(private readonly options: {
    assetRoot: string;
    fetch: AssetFetch;
    resolveHost: ResolveHost;
    maxRedirects?: number;
  }) {
    this.maxRedirects = options.maxRedirects ?? 4;
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
      current = await assertSafeRemoteUrl(current.toString(), this.options.resolveHost);
      response = await this.options.fetch(current.toString());
      if (response.status < 300 || response.status >= 400) break;
      const location = header(response, "location");
      if (!location) throw new Error("redirect response is missing Location");
      if (redirects === this.maxRedirects) throw new Error("redirect limit exceeded");
      current = new URL(location, current);
    }

    if (!response || response.status < 200 || response.status >= 300 || !response.body) {
      throw new Error(`asset download failed with status ${response?.status ?? "unknown"}`);
    }

    const extension = extensionFor(header(response, "content-type"), current);
    const temporaryPath = join(this.options.assetRoot, `.tmp-${randomUUID()}`);
    const hash = createHash("sha256");
    let bytes = 0;
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      for await (const rawChunk of response.body) {
        const chunk = Buffer.from(rawChunk);
        hash.update(chunk);
        bytes += chunk.byteLength;
        await file.write(chunk);
      }
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
