import { describe, expect, it, vi } from "vitest";

import { createWorkerApplication, LIVE_MIAOSHOU_MIN_INTERVAL_MS } from "./entry.js";

const testEnv = {
  NODE_ENV: "test",
  EXTERNAL_ADAPTER_MODE: "live",
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench",
  TEST_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench_test",
  LOCAL_OPERATOR_ID: "local-operator",
  EXTENSION_TOKEN: "test-extension-token"
} satisfies NodeJS.ProcessEnv;

describe("worker entry", () => {
  it("uses a non-zero live Miaoshou request interval", () => {
    expect(LIVE_MIAOSHOU_MIN_INTERVAL_MS).toBeGreaterThan(0);
  });
  it("rejects live adapters in tests before constructing database or HTTP clients", () => {
    const createPool = vi.fn();
    const createAdapterBundle = vi.fn();
    const createMiaoshou = vi.fn();

    expect(() => createWorkerApplication({
      env: testEnv,
      processKind: "test",
      dependencies: { createPool, createAdapterBundle, createMiaoshou }
    })).toThrow("refusing to boot test/integration/e2e process with external adapter mode=live");

    expect(createPool).not.toHaveBeenCalled();
    expect(createAdapterBundle).not.toHaveBeenCalled();
    expect(createMiaoshou).not.toHaveBeenCalled();
  });

  it("shares one env-aware fetch across every live adapter and closes it with the worker", async () => {
    const closeFetch = vi.fn(async () => undefined);
    const liveFetch = Object.assign(vi.fn(), { close: closeFetch }) as unknown as typeof fetch;
    const createLiveFetch = vi.fn(() => liveFetch);
    const createMiaoshou = vi.fn(() => ({ fetchItem: vi.fn() }));
    const createMiaoshouEdit = vi.fn(() => ({ applyEdit: vi.fn(), reconcile: vi.fn() }));
    const end = vi.fn(async () => undefined);
    const application = createWorkerApplication({
      env: {
        ...testEnv,
        NODE_ENV: "production",
        EXTERNAL_ADAPTER_MODE: "live",
        MIAOSHOU_APP_KEY: "miaoshou-key",
        MIAOSHOU_APP_SECRET: "miaoshou-secret",
        CANVAS_BASE_URL: "https://canvas.test",
        CANVAS_API_KEY: "canvas-key",
        LLM_BASE_URL: "https://llm.test/v1",
        LLM_API_KEY: "llm-key",
        LLM_MODEL: "model-1",
        EXCHANGE_RATE_BASE_URL: "https://rates.test",
        ASSET_ROOT: "/tmp/tk-worker-live-assets"
      },
      processKind: "app",
      commandContext: { kind: "worker_command", commandId: "command_123", idempotencyKey: "stable:key:123" },
      dependencies: {
        createPool: vi.fn(() => ({ query: vi.fn(), connect: vi.fn(), end }) as never),
        createMiaoshou: createMiaoshou as never,
        createMiaoshouEdit: createMiaoshouEdit as never,
        createLiveFetch
      } as never
    });

    expect(createLiveFetch).toHaveBeenCalledTimes(1);
    expect((createMiaoshou.mock.calls[0] as unknown[])?.[1]).toBe(liveFetch);
    expect((createMiaoshouEdit.mock.calls[0] as unknown[])?.[2]).toBe(liveFetch);
    await application.close();
    expect(closeFetch).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
