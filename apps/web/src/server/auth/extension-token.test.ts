import { describe, expect, it, vi } from "vitest";

import { createDynamicExtensionTokenVerifier } from "./extension-token.js";

describe("dynamic extension token verifier", () => {
  it("loads the current token for every request so UI changes apply without restart", async () => {
    let token = "first-token";
    const loadToken = vi.fn(async () => token);
    const verify = createDynamicExtensionTokenVerifier(loadToken);

    await expect(verify("Bearer first-token")).resolves.toBe(true);
    token = "second-token";
    await expect(verify("Bearer first-token")).resolves.toBe(false);
    await expect(verify("Bearer second-token")).resolves.toBe(true);
    expect(loadToken).toHaveBeenCalledTimes(3);
  });

  it("fails closed when no configured token exists", async () => {
    const verify = createDynamicExtensionTokenVerifier(async () => "");

    await expect(verify("Bearer anything")).resolves.toBe(false);
  });
});
