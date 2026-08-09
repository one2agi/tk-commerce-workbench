import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import {
  SECRET_FIELD_NAMES,
  type EncryptedSecretEnvelopeV1,
  type RuntimeSecretsV1,
  type SecretFieldName
} from "../../contracts/src/runtime-configuration.js";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const ENVELOPE_VERSION = 1;

export interface RuntimeSecretCodec {
  seal(secrets: RuntimeSecretsV1, recordId: string): EncryptedSecretEnvelopeV1;
  open(envelope: EncryptedSecretEnvelopeV1, recordId: string): RuntimeSecretsV1;
}

function additionalData(recordId: string): Buffer {
  return Buffer.from(`runtime-config:v${ENVELOPE_VERSION}:${recordId}`, "utf8");
}

function decodeStrictBase64(value: string): Buffer | undefined {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}

function decodeSecrets(value: string): RuntimeSecretsV1 {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid secret payload");
  }
  const allowed = new Set<string>(SECRET_FIELD_NAMES);
  const secrets: Partial<Record<SecretFieldName, string>> = {};
  for (const [name, secret] of Object.entries(parsed)) {
    if (!allowed.has(name) || typeof secret !== "string") {
      throw new Error("invalid secret payload");
    }
    secrets[name as SecretFieldName] = secret;
  }
  return secrets;
}

export function createRuntimeSecretCodec(masterKeyBase64: string): RuntimeSecretCodec {
  const key = decodeStrictBase64(masterKeyBase64);
  if (!key) {
    throw new Error("config: CONFIG_ENCRYPTION_KEY must be strict base64");
  }
  if (key.byteLength !== 32) {
    throw new Error("config: CONFIG_ENCRYPTION_KEY must decode to 32 bytes");
  }

  return {
    seal(secrets, recordId) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, nonce);
      cipher.setAAD(additionalData(recordId));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(secrets), "utf8"),
        cipher.final()
      ]);
      return {
        version: ENVELOPE_VERSION,
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64")
      };
    },

    open(envelope, recordId) {
      try {
        if (envelope.version !== ENVELOPE_VERSION) throw new Error("unsupported envelope");
        const nonce = decodeStrictBase64(envelope.nonce);
        const tag = decodeStrictBase64(envelope.tag);
        const ciphertext = decodeStrictBase64(envelope.ciphertext);
        if (!nonce || nonce.byteLength !== NONCE_BYTES || !tag || tag.byteLength !== 16 || !ciphertext) {
          throw new Error("invalid envelope encoding");
        }
        const decipher = createDecipheriv(
          ALGORITHM,
          key,
          nonce
        );
        decipher.setAAD(additionalData(recordId));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final()
        ]).toString("utf8");
        return decodeSecrets(plaintext);
      } catch {
        throw new Error("runtime configuration secrets could not be decrypted");
      }
    }
  };
}
