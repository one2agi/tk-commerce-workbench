// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { registerDetailCaptureHandler, sendRuntimeMessageSilently } from "./index.js";

describe("content runtime messaging", () => {
  it("registers the detail capture handler only once when content.js is reinjected", () => {
    delete (globalThis as { __tkDetailCaptureHandlerRegistered?: boolean }).__tkDetailCaptureHandlerRegistered;
    const runtime = {
      onMessage: {
        addListener: vi.fn()
      }
    };
    const currentDocument = {
      location: { href: "https://detail.1688.com/offer/892408514788.html" }
    } as unknown as Document;

    registerDetailCaptureHandler(runtime, currentDocument);
    registerDetailCaptureHandler(runtime, currentDocument);

    expect(runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    delete (globalThis as { __tkDetailCaptureHandlerRegistered?: boolean }).__tkDetailCaptureHandlerRegistered;
  });

  it("does not throw when Chrome sendMessage uses the callback-style void return", () => {
    const runtime = {
      sendMessage: vi.fn(() => undefined)
    };

    expect(() => sendRuntimeMessageSilently(runtime, { kind: "capture-stage", stage: "loading_detail" }))
      .not.toThrow();
  });

  it("swallows rejected promise-style sendMessage results", async () => {
    const runtime = {
      sendMessage: vi.fn(() => Promise.reject(new Error("receiver_missing")))
    };

    sendRuntimeMessageSilently(runtime, { kind: "capture-stage", stage: "loading_detail" });
    await Promise.resolve();

    expect(runtime.sendMessage).toHaveBeenCalled();
  });
});
