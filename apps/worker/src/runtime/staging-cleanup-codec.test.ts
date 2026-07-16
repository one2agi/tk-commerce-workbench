import { describe, expect, it } from "vitest";
import { createStagingCleanupCodec } from "./staging-cleanup-codec.js";

describe("staging cleanup codec", () => {
  it("persists only an authenticated envelope, not presigned bearer URLs", () => {
    const codec = createStagingCleanupCodec("stable-local-worker-secret");
    const urls = ["https://stage.test/a.png?signature=secret-bearer"];
    const envelope = codec.protect(urls);
    expect(envelope).not.toContain("stage.test");
    expect(envelope).not.toContain("signature");
    expect(codec.unprotect(envelope)).toEqual(urls);
  });
});
