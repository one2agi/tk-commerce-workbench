import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { createRuntimeSecretCodec } from "./runtime-secrets.js";

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

describe("runtime secret codec", () => {
  it("round-trips secrets without exposing plaintext in the envelope", () => {
    const codec = createRuntimeSecretCodec(MASTER_KEY);
    const envelope = codec.seal({
      imageProviderApiKey: "provider-secret",
      extensionToken: "extension-secret"
    }, "workspace_settings:1");

    expect(JSON.stringify(envelope)).not.toContain("provider-secret");
    expect(JSON.stringify(envelope)).not.toContain("extension-secret");
    expect(codec.open(envelope, "workspace_settings:1")).toEqual({
      imageProviderApiKey: "provider-secret",
      extensionToken: "extension-secret"
    });
  });

  it("uses a fresh nonce for every encryption", () => {
    const codec = createRuntimeSecretCodec(MASTER_KEY);
    const first = codec.seal({ imageProviderApiKey: "same-secret" }, "workspace_settings:1");
    const second = codec.seal({ imageProviderApiKey: "same-secret" }, "workspace_settings:1");

    expect(second.nonce).not.toBe(first.nonce);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  it("rejects a malformed master key", () => {
    expect(() => createRuntimeSecretCodec("short")).toThrow(
      "config: CONFIG_ENCRYPTION_KEY must decode to 32 bytes"
    );
  });

  it("rejects a wrong record identity or tampered ciphertext with one safe error", () => {
    const codec = createRuntimeSecretCodec(MASTER_KEY);
    const envelope = codec.seal({ imageProviderApiKey: "provider-secret" }, "workspace_settings:1");
    const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` };

    expect(() => codec.open(envelope, "workspace_settings:2")).toThrow(
      "runtime configuration secrets could not be decrypted"
    );
    expect(() => codec.open(tampered, "workspace_settings:1")).toThrow(
      "runtime configuration secrets could not be decrypted"
    );
  });
});
