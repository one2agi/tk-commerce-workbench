import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import { externalFailure, type AssetPublishingPort, type PublishingPurpose } from "@tk/contracts";

const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const MAX_FILE_SIZE_BYTES = 12 * 1024 * 1024; // 12 MB

export interface AssetPublishingAdapterConfig {
  readonly s3Endpoint: string;
  readonly s3Region: string;
  readonly s3Bucket: string;
  readonly s3AccessKeyId: string;
  readonly s3SecretAccessKey: string;
  readonly publicBaseUrl: string;
  readonly assetRoot: string;
  readonly fetchImpl?: typeof fetch;
}

function validatePublicBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw externalFailure("fatal", "publishing.invalid_public_base_url", "Asset publishing public base URL is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw externalFailure("fatal", "publishing.invalid_public_base_url", "Asset publishing public base URL must use HTTPS");
  }
}

function computeSha256(bytes: Uint8Array): string {
  return createHash("sha256").digest("hex");
}

export function createAssetPublishingAdapter(config: AssetPublishingAdapterConfig): AssetPublishingPort {
  validatePublicBaseUrl(config.publicBaseUrl);

  const s3Client = new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    credentials: {
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey
    },
    forcePathStyle: false
  });

  const tracked = new Set<string>();

  return {
    async publish({ assets, purpose }) {
      if (assets.length === 0) return [];
      if (new Set(assets.map((a) => a.assetId)).size !== assets.length) {
        throw externalFailure("needs_input", "publishing.duplicate_asset_ids", "Asset publishing requires unique asset identifiers");
      }
      if (purpose !== "miaoshou_edit") {
        throw externalFailure("fatal", "publishing.unsupported_purpose", "Asset publishing only supports miaoshou_edit purpose");
      }

      const results: Array<{ remoteUrl: string }> = [];
      const root = resolve(config.assetRoot);

      for (const asset of assets) {
        const extension = asset.extension.startsWith(".")
          ? asset.extension
          : `.${asset.extension}`;

        if (!SUPPORTED_EXTENSIONS.has(extension.toLowerCase())) {
          throw externalFailure("fatal", "publishing.unsupported_extension", `Asset publishing only supports ${[...SUPPORTED_EXTENSIONS].join(", ")}`);
        }

        const localPath = resolve(root, asset.localPath);
        // Ensure the local path is within the asset root
        if (!localPath.startsWith(`${root}${sep}`) && localPath !== root) {
          throw externalFailure("needs_input", "publishing.asset_path_escape", "Asset publishing: local path escapes asset root");
        }

        let fileBytes: Uint8Array;
        try {
          fileBytes = await readFile(localPath);
        } catch {
          throw externalFailure("needs_input", "publishing.asset_not_found", `Asset publishing could not read local asset: ${asset.localPath}`);
        }

        if (fileBytes.byteLength === 0) {
          throw externalFailure("needs_input", "publishing.empty_asset", "Asset publishing: asset file is empty");
        }
        if (fileBytes.byteLength > MAX_FILE_SIZE_BYTES) {
          throw externalFailure("needs_input", "publishing.asset_too_large", `Asset publishing: asset exceeds ${MAX_FILE_SIZE_BYTES} bytes`);
        }

        const sha256 = computeSha256(fileBytes);

        const objectKey = `images/${sha256}.${extension}`;
        const remoteUrl = `${config.publicBaseUrl.replace(/\/+$/, "")}/${objectKey}`;

        // HeadObject first - skip upload if already exists
        let alreadyExists = false;
        try {
          await s3Client.send(new HeadObjectCommand({
            Bucket: config.s3Bucket,
            Key: objectKey
          }));
          alreadyExists = true;
        } catch (err: unknown) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status !== 404) {
            throw externalFailure("retryable", "publishing.s3_head_failed", "Asset publishing: S3 HeadObject check failed");
          }
          // 404 means it does not exist - we will upload
        }

        if (!alreadyExists) {
          const contentType = extension === ".png"
            ? "image/png"
            : "image/jpeg";

          try {
            await s3Client.send(new PutObjectCommand({
              Bucket: config.s3Bucket,
              Key: objectKey,
              Body: fileBytes,
              ContentType: contentType,
              CacheControl: "max-age=31536000", // 1 year cache
              Metadata: { "asset-id": asset.assetId }
            }));
          } catch {
            throw externalFailure("retryable", "publishing.s3_put_failed", "Asset publishing: S3 PutObject failed");
          }
        }

        tracked.add(remoteUrl);
        results.push(Object.freeze({ remoteUrl }));
      }

      return results;
    },

    async release({ remoteUrls }) {
      const owned = [...new Set(remoteUrls)].filter((url) => tracked.has(url));
      for (const url of owned) tracked.delete(url);
    }
  };
}
