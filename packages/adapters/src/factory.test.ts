import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idempotencyKey } from "@tk/contracts";
import { getGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as factoryModule from "./factory.js";
import { createAdapterBundle } from "./factory.js";

const mockConfig = { externalAdapterMode: "mock" as const, nodeEnv: "development" as const, assetRoot: "./data/assets" };
const temporaryDirectories: string[] = [];
type ExportedEnvFetchFactory = (
  env: NodeJS.ProcessEnv,
  deps: {
    createDispatcher(options: { httpProxy?: string; httpsProxy?: string; noProxy?: string }): unknown;
    transport: (input: string | URL | Request, init?: RequestInit & { dispatcher?: unknown }) => Promise<Response>;
  }
) => typeof fetch & { close(): Promise<void> };

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("adapter bundle factory cost boundary", () => {
  it("returns deterministic fakes in mock mode without constructing a network client", () => {
    const constructLive = vi.fn(() => { throw new Error("must not construct live"); });
    const createLiveFetch = vi.fn(() => { throw new Error("must not construct dispatcher"); });
    const bundle = createAdapterBundle(mockConfig, undefined, { constructLive, createLiveFetch });
    expect(bundle.mode).toBe("mock");
    expect(bundle.counters()).toEqual({ canvas: 0, llm: 0, exchangeRate: 0, assetStaging: 0 });
    expect(constructLive).not.toHaveBeenCalled();
    expect(createLiveFetch).not.toHaveBeenCalled();
  });

  it("counts deterministic mock calls without touching a network", async () => {
    const bundle = createAdapterBundle(mockConfig);
    await bundle.canvas.readWorkflowCapacity("workflow_1");
    await bundle.exchangeRate.latestSnapshot({ base: "CNY", target: "THB" });
    expect(bundle.counters()).toEqual({ canvas: 1, llm: 0, exchangeRate: 1, assetStaging: 0 });
  });

  it.each(["test", "integration", "e2e"] as const)("fails closed for live mode in %s", (processKind) => {
    expect(() => createAdapterBundle({ ...mockConfig, externalAdapterMode: "live", processKind }, { kind: "worker_command", commandId: "command_123", idempotencyKey: "stable:key:123" })).toThrow(/refusing live adapters/i);
  });

  it("requires an explicit stable command context before constructing live clients", () => {
    const constructLive = vi.fn();
    expect(() => createAdapterBundle({ ...mockConfig, externalAdapterMode: "live", nodeEnv: "production" }, undefined, { constructLive })).toThrow(/command context/i);
    expect(constructLive).not.toHaveBeenCalled();
  });

  it("constructs live adapters only after a valid command context", () => {
    const sentinel = createAdapterBundle(mockConfig);
    const constructLive = vi.fn(() => ({ ...sentinel, mode: "live" as const }));
    const result = createAdapterBundle({ ...mockConfig, externalAdapterMode: "live", nodeEnv: "production" }, { kind: "worker_command", commandId: "command_123", idempotencyKey: "stable:key:123" }, { constructLive });
    expect(result.mode).toBe("live");
    expect(constructLive).toHaveBeenCalledTimes(1);
  });

  it("injects one shared env-aware fetch into every production live adapter", async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), "tk-adapter-proxy-"));
    temporaryDirectories.push(assetRoot);
    await writeFile(join(assetRoot, "asset.png"), new Uint8Array([1, 2, 3]));
    const requests: string[] = [];
    const sharedFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/workflows")) return new Response(JSON.stringify({ workflows: [{ workflow_id: "workflow_1", workflow_version: 1, input_image_count: 9, expected_output_count: 5 }] }), { status: 200 });
      if (url.endsWith("/chat/completions")) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: "Source title", description: "Source description", translatedAttributes: [{ name: "Color", value: "Black" }], styleApplied: "neutral", fallbackUsed: false,
        evidenceMappings: [
          { outputPath: "title", sourcePath: "sourceTitle", sourceQuote: "Source title" },
          { outputPath: "description", sourcePath: "sourceDescription", sourceQuote: "Source description" },
          { outputPath: "translatedAttributes.0.name", sourcePath: "sourceAttributes.0.name", sourceQuote: "Color" },
          { outputPath: "translatedAttributes.0.value", sourcePath: "sourceAttributes.0.value", sourceQuote: "Black" }
        ]
      }) } }] }), { status: 200 });
      if (url.startsWith("https://rates.test")) return new Response(JSON.stringify({ rates: { THB: 4.82 } }), { status: 200 });
      if (url.endsWith("/api/automation/upload")) return new Response(JSON.stringify({ url: "https://canvas.test/uploads/asset.png" }), { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const createLiveFetch = vi.fn(() => sharedFetch);
    const bundle = createAdapterBundle({
      externalAdapterMode: "live", nodeEnv: "production", assetRoot,
      canvasBaseUrl: "https://canvas.test", canvasId: "canvas-local-1", canvasWorkflowName: "Local TK", canvasApiKey: "canvas-secret",
      llmBaseUrl: "https://llm.test/v1", llmApiKey: "llm-secret", llmModel: "model-1",
      exchangeRateBaseUrl: "https://rates.test"
    }, { kind: "worker_command", commandId: "command_123", idempotencyKey: "stable:key:123" }, { createLiveFetch });

    expect(createLiveFetch).toHaveBeenCalledTimes(1);
    await bundle.canvas.readWorkflowCapacity("workflow_1");
    await bundle.llm.generateListing({
      sourceLocale: "en-US", targetLocale: "en-US", style: "neutral",
      evidence: { sourceTitle: "Source title", sourceDescription: "Source description", sourceAttributes: [{ name: "Color", value: "Black" }] },
      idempotencyKey: idempotencyKey("llm:proxy:shared")
    });
    await bundle.exchangeRate.fetchSnapshot({ base: "CNY", target: "THB" });
    await bundle.assetStaging.stage({ localAssetIds: ["asset.png"], purpose: "canvas" });
    expect(sharedFetch).toHaveBeenCalledTimes(4);
    expect(requests).toEqual([
      "https://canvas.test/api/automation/canvases/canvas-local-1/workflows",
      "https://llm.test/v1/chat/completions",
      "https://rates.test/?base=CNY&symbols=THB",
      "https://canvas.test/api/automation/upload"
    ]);
  });

  it("constructs a live Canvas adapter without an API key for no-auth Canvas deployments", async () => {
    const sharedFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
      expect(String(input)).toBe("https://canvas.test/api/automation/canvases/0f91cb2d8f2846c091829af30ea2d18d/workflows");
      return new Response(JSON.stringify({
        workflows: [{ workflow_id: "workflow_1", workflow_version: 1, input_image_count: 9, expected_output_count: 5 }]
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const bundle = createAdapterBundle({
      externalAdapterMode: "live", nodeEnv: "production", assetRoot: "./data/assets",
      canvasBaseUrl: "https://canvas.test",
      llmBaseUrl: "https://llm.test/v1", llmApiKey: "llm-secret", llmModel: "model-1",
      exchangeRateBaseUrl: "https://rates.test"
    }, { kind: "worker_command", commandId: "command_123", idempotencyKey: "stable:key:123" }, {
      createLiveFetch: () => sharedFetch
    });

    await expect(bundle.canvas.readWorkflowCapacity("workflow_1")).resolves.toMatchObject({
      workflowId: "workflow_1",
      inputCapacity: 9,
      expectedOutputCount: 5
    });
    expect(sharedFetch).toHaveBeenCalledTimes(1);
  });

  it("downloads same-origin remote Canvas outputs through the shared env-aware fetch", async () => {
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    new DataView(png.buffer).setUint32(16, 2);
    new DataView(png.buffer).setUint32(20, 3);
    const sharedFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/automation/workflow-runs/remote-task-1")) {
        return new Response(JSON.stringify({ status: "succeeded", images: ["/assets/output/generated.png"] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url === "https://canvas.test/assets/output/generated.png") {
        return new Response(png, {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(png.byteLength) }
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const bundle = createAdapterBundle({
      externalAdapterMode: "live", nodeEnv: "production", assetRoot: "./data/assets",
      canvasBaseUrl: "https://canvas.test",
      llmBaseUrl: "https://llm.test/v1", llmApiKey: "llm-secret", llmModel: "model-1",
      exchangeRateBaseUrl: "https://rates.test"
    }, { kind: "worker_command", commandId: "command_123", idempotencyKey: "stable:key:123" }, {
      createLiveFetch: () => sharedFetch
    });

    await expect(bundle.canvas.fetchOutputs({ remoteTaskId: "remote-task-1" })).resolves.toEqual({
      outputs: [{
        url: "https://canvas.test/assets/output/generated.png",
        width: 2,
        height: 3,
        sha256: createHash("sha256").update(png).digest("hex")
      }]
    });
    expect(sharedFetch).toHaveBeenCalledWith("https://canvas.test/assets/output/generated.png", expect.objectContaining({
      headers: expect.objectContaining({ accept: "image/png,image/jpeg" })
    }));
  });

  it("exports an env-aware fetch helper without changing the global dispatcher or logging proxy credentials", async () => {
    const createEnvAwareFetch = (factoryModule as unknown as { createEnvAwareFetch: ExportedEnvFetchFactory }).createEnvAwareFetch;
    expect(createEnvAwareFetch).toBeTypeOf("function");
    const dispatch = vi.fn();
    const close = vi.fn(async () => undefined);
    const dispatcher = { dispatch, close };
    const createDispatcher = vi.fn(() => dispatcher);
    const transport = vi.fn(async () => new Response("ok", { status: 200 }));
    const consoleSpies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const globalDispatcher = getGlobalDispatcher();
    const fetchImpl = createEnvAwareFetch({
      HTTP_PROXY: "http://user:password@proxy.test:8080",
      HTTPS_PROXY: "http://user:password@secure-proxy.test:8443",
      NO_PROXY: "localhost,.internal.test"
    }, { createDispatcher, transport });

    expect((fetchImpl as typeof fetch & { close?: unknown }).close).toBeTypeOf("function");
    await expect(fetchImpl("https://external.test/metadata")).resolves.toBeInstanceOf(Response);
    expect(createDispatcher).toHaveBeenCalledWith({
      httpProxy: "http://user:password@proxy.test:8080",
      httpsProxy: "http://user:password@secure-proxy.test:8443",
      noProxy: "localhost,.internal.test"
    });
    expect(transport).toHaveBeenCalledWith("https://external.test/metadata", expect.objectContaining({ dispatcher }));
    expect(getGlobalDispatcher()).toBe(globalDispatcher);
    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    await (fetchImpl as typeof fetch & { close(): Promise<void> }).close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("prefers lowercase proxy variables and isolates an explicit custom env from process.env fallbacks", async () => {
    const createEnvAwareFetch = (factoryModule as unknown as { createEnvAwareFetch: ExportedEnvFetchFactory }).createEnvAwareFetch;
    const dispatcher = { close: vi.fn(async () => undefined) };
    const createDispatcher = vi.fn(() => dispatcher);
    const transport = vi.fn(async () => new Response("ok", { status: 200 }));

    const fetchImpl = createEnvAwareFetch({
      http_proxy: "http://lower-http.test:8080",
      HTTP_PROXY: "http://upper-http.test:8080",
      https_proxy: "http://lower-https.test:8443",
      HTTPS_PROXY: "http://upper-https.test:8443",
      no_proxy: "lower.internal.test",
      NO_PROXY: "upper.internal.test"
    }, { createDispatcher, transport });
    expect(createDispatcher).toHaveBeenCalledWith({
      httpProxy: "http://lower-http.test:8080",
      httpsProxy: "http://lower-https.test:8443",
      noProxy: "lower.internal.test"
    });
    await fetchImpl.close();

    createDispatcher.mockClear();
    const isolatedFetch = createEnvAwareFetch({}, { createDispatcher, transport });
    expect(createDispatcher).toHaveBeenCalledWith({ httpProxy: "", httpsProxy: "", noProxy: "" });
    await isolatedFetch.close();
  });

  it("redacts proxy credentials when dispatcher construction rejects an invalid URL", () => {
    const sentinel = "PROXY_SECRET_SENTINEL_DO_NOT_LOG";
    let serialized = "";
    try {
      (factoryModule as unknown as { createEnvAwareFetch(env: NodeJS.ProcessEnv): typeof fetch }).createEnvAwareFetch({
        HTTPS_PROXY: `http://user:${sentinel}@[`
      });
    } catch (error) {
      serialized = JSON.stringify(error);
    }
    expect(serialized).toContain("adapter.proxy_invalid");
    expect(serialized).not.toContain(sentinel);
  });

  it("refuses live worker startup with an incomplete image provider", () => {
    expect(() => createAdapterBundle(
      { externalAdapterMode: "live", nodeEnv: "production", assetRoot: "./data/assets", imageProviderApiKey: "" },
      { kind: "worker_command", commandId: "command_123", idempotencyKey: "stable:key:123" }
    )).toThrow("live adapter configuration is incomplete");
  });
});
