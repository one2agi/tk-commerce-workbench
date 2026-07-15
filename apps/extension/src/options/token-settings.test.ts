// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createTokenSettings } from "./token-settings.js";

describe("token settings", () => {
  it("stores only the raw client token and exposes no placeholder digest", async () => {
    const set = vi.fn(async () => undefined);
    const settings = createTokenSettings({
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set,
          remove: vi.fn(async () => undefined)
        }
      }
    });

    expect(settings).not.toHaveProperty("hashForDigest");
    await settings.save("  token-value  ");
    expect(set).toHaveBeenCalledWith({ extensionToken: "token-value" });
  });
});
