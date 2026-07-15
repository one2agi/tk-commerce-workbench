import { describe, expect, it } from "vitest";
import { getSecretStatus, loadConfig } from "./env.js";

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench",
  TEST_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench_test",
  LOCAL_OPERATOR_ID: "operator_local_01",
  EXTENSION_TOKEN: "test-token-do-not-log",
  ALLOW_LAN: "false",
  EXTERNAL_ADAPTER_MODE: "mock",
  ASSET_ROOT: "./data/assets",
  WORKER_CONCURRENCY: "2",
  WORKER_LEASE_MS: "60000",
  MAX_CANVAS_RUNS_PER_DAY: "50",
  NODE_ENV: "test"
};

describe("config env", () => {
  it("parses loopback-friendly base configuration", () => {
    const cfg = loadConfig(BASE_ENV);
    expect(cfg.localOperatorId).toBe("operator_local_01");
    expect(cfg.allowLan).toBe(false);
    expect(cfg.externalAdapterMode).toBe("mock");
  });

  it("refuses to boot test/integration/e2e in live external adapter mode", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, EXTERNAL_ADAPTER_MODE: "live", NODE_ENV: "test" })
    ).toThrow(/external adapter mode=live/i);
  });

  it("returns booleans only from getSecretStatus", () => {
    const cfg = loadConfig(BASE_ENV);
    const status = getSecretStatus(cfg);
    expect(status.miaoshouConfigured).toBe(false);
    expect(status.canvasConfigured).toBe(false);
    expect(status.llmConfigured).toBe(false);
    expect(status).not.toHaveProperty("miaoshouAppKey");
    expect(status).not.toHaveProperty("miaoshouAppSecret");
  });
});
