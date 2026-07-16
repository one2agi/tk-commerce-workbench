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
});
