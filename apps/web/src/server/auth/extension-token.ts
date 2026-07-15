import { createHash, timingSafeEqual } from "node:crypto";

export type ExtensionTokenVerifier = (authorization: string | null) => Promise<boolean>;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function createExtensionTokenVerifier(expectedToken: string): ExtensionTokenVerifier {
  const expectedDigest = digest(expectedToken);
  return async (authorization) => {
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
    const candidateDigest = digest(match?.[1] ?? "");
    return Boolean(match) && timingSafeEqual(candidateDigest, expectedDigest);
  };
}
