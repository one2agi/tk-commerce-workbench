import { describe, expect, it } from "vitest";
import { createStagingCleanupCodec } from "./staging-cleanup-codec.js";

describe("staging cleanup codec", () => {
  it("persists only an authenticated envelope, not presigned bearer URLs", () => {
    const codec = createStagingCleanupCodec("stable-local-worker-secret");
    const handle = { remoteUrls: ["https://stage.test/a.png?signature=secret-bearer"], expiresAt: "2026-07-16T01:00:00Z" };
    const envelope = codec.protect(handle);
    expect(envelope).not.toContain("stage.test");
    expect(envelope).not.toContain("signature");
    expect(codec.unprotect(envelope)).toEqual(handle);
  });
});
