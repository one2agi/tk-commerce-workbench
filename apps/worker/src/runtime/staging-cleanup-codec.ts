import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface StagingCleanupCodec {
  protect(remoteUrls: readonly string[]): string;
  unprotect(envelope: string): string[];
}

export function createStagingCleanupCodec(secret: string): StagingCleanupCodec {
  if (secret.length < 8) throw new Error("staging cleanup codec secret is too short");
  const key = createHash("sha256").update(`tk-staging-cleanup:${secret}`).digest();
  return {
    protect(remoteUrls) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(remoteUrls), "utf8"), cipher.final()]);
      return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
    },
    unprotect(envelope) {
      const [ivText, tagText, ciphertextText] = envelope.split(".");
      if (!ivText || !tagText || !ciphertextText) throw new Error("invalid staging cleanup envelope");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
      decipher.setAuthTag(Buffer.from(tagText, "base64url"));
      const value = JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()
      ]).toString("utf8"));
      if (!Array.isArray(value) || value.some((url) => typeof url !== "string")) throw new Error("invalid staging cleanup URLs");
      return value;
    }
  };
}
