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

export function createDynamicExtensionTokenVerifier(
  loadExpectedToken: () => Promise<string>
): ExtensionTokenVerifier {
  return async (authorization) => {
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
    if (!match) return false;
    try {
      const expectedToken = await loadExpectedToken();
      if (!expectedToken) return false;
      return timingSafeEqual(digest(match[1]), digest(expectedToken));
    } catch {
      return false;
    }
  };
}
