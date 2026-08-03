import "@testing-library/jest-dom/vitest";
// @ts-expect-error The workspace provides the jsdom runtime without @types/jsdom.
import { JSDOM } from "jsdom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { ImageGenerationViewV1 } from "@tk/contracts/read-models";
import { assetId } from "@tk/contracts/ids";
import { ImageGenerationPanel } from "./image-generation-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() })
}));

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: "http://127.0.0.1"
});

beforeAll(() => {
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent
  })) {
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
}, 30000);

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

afterEach(() => {
  cleanup();
});

function readyModel(): ImageGenerationViewV1 {
  return {
    batchId: null,
    availableInputs: [
      { assetId: assetId("asset_1"), localUrl: "/api/v1/assets/asset_1", role: "main" },
      { assetId: assetId("asset_2"), localUrl: "/api/v1/assets/asset_2", role: "main" },
      { assetId: assetId("asset_3"), localUrl: "/api/v1/assets/asset_3", role: "detail" }
    ],
    selectedInputs: [
      { assetId: assetId("asset_1"), localUrl: "/api/v1/assets/asset_1" },
      { assetId: assetId("asset_2"), localUrl: "/api/v1/assets/asset_2" }
    ],
    inferredCategory: "electronics.smartphone",
    confirmedCategory: null,
    requestedCount: 4,
    successfulCount: 0,
    state: "not_started",
    slots: [],
    warnings: []
  };
}

function partialWithWaitingSlot(): ImageGenerationViewV1 {
  return {
    batchId: "batch_1",
    availableInputs: [
      { assetId: assetId("asset_1"), localUrl: "/api/v1/assets/asset_1", role: "main" },
      { assetId: assetId("asset_2"), localUrl: "/api/v1/assets/asset_2", role: "main" }
    ],
    selectedInputs: [
      { assetId: assetId("asset_1"), localUrl: "/api/v1/assets/asset_1" },
      { assetId: assetId("asset_2"), localUrl: "/api/v1/assets/asset_2" }
    ],
    inferredCategory: "electronics.smartphone",
    confirmedCategory: "electronics.smartphone",
    requestedCount: 5,
    successfulCount: 4,
    state: "partial",
    slots: [
      { slotId: "slot_1", slotNumber: 1, role: "main", status: "succeeded", attempt: 1, localUrl: "/api/v1/assets/out_1", error: null },
      { slotId: "slot_2", slotNumber: 2, role: "main", status: "succeeded", attempt: 1, localUrl: "/api/v1/assets/out_2", error: null },
      { slotId: "slot_3", slotNumber: 3, role: "detail", status: "succeeded", attempt: 1, localUrl: "/api/v1/assets/out_3", error: null },
      { slotId: "slot_4", slotNumber: 4, role: "detail", status: "failed", attempt: 1, localUrl: null, error: "provider_error" },
      { slotId: "slot_5", slotNumber: 5, role: "detail", status: "queued", attempt: 1, localUrl: null, error: null }
    ],
    warnings: []
  };
}

function partialModel(): ImageGenerationViewV1 {
  return {
    batchId: "batch_1",
    availableInputs: [
      { assetId: assetId("asset_1"), localUrl: "/api/v1/assets/asset_1", role: "main" },
      { assetId: assetId("asset_2"), localUrl: "/api/v1/assets/asset_2", role: "main" }
    ],
    selectedInputs: [
      { assetId: assetId("asset_1"), localUrl: "/api/v1/assets/asset_1" },
      { assetId: assetId("asset_2"), localUrl: "/api/v1/assets/asset_2" }
    ],
    inferredCategory: "electronics.smartphone",
    confirmedCategory: "electronics.smartphone",
    requestedCount: 5,
    successfulCount: 4,
    state: "partial",
    slots: [
      { slotId: "slot_1", slotNumber: 1, role: "main", status: "succeeded", attempt: 1, localUrl: "/api/v1/assets/out_1", error: null },
      { slotId: "slot_2", slotNumber: 2, role: "main", status: "succeeded", attempt: 1, localUrl: "/api/v1/assets/out_2", error: null },
      { slotId: "slot_3", slotNumber: 3, role: "detail", status: "succeeded", attempt: 1, localUrl: "/api/v1/assets/out_3", error: null },
      { slotId: "slot_4", slotNumber: 4, role: "detail", status: "failed", attempt: 1, localUrl: null, error: "provider_error" },
      { slotId: "slot_5", slotNumber: 5, role: "detail", status: "succeeded", attempt: 1, localUrl: "/api/v1/assets/out_5", error: null }
    ],
    warnings: []
  };
}

describe("ImageGenerationPanel", () => {
  it("starts the default flow with one action", async () => {
    const user = userEvent.setup({ document: globalThis.document });
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ batchId: "batch_1", plannerJobId: "job_1" }) });

    const { getByRole } = render(
      <ImageGenerationPanel
        productId="prod_1"
        revisionId="rev_1"
        imageGeneration={readyModel()}
      />
    );

    await user.click(getByRole("button", { name: "开始洗图" }));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toContain("/image-generations");
    expect(opts.method).toBe("POST");
    expect(JSON.parse((opts as Record<string, unknown>).body as string)).toMatchObject({
      revisionId: "rev_1",
      categoryKey: "electronics.smartphone",
      selectedAssetIds: ["asset_1", "asset_2"],
      outputCount: 4
    });
  });

  it("retries only image four after partial completion", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    const user = userEvent.setup({ document: globalThis.document });

    const { getByRole } = render(
      <ImageGenerationPanel
        productId="prod_1"
        revisionId="rev_1"
        imageGeneration={partialModel()}
      />
    );

    await user.click(getByRole("button", { name: "重新生成这张" }));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/slots/slot_4"),
      expect.objectContaining({ method: "PATCH", body: expect.stringContaining("retry") })
    );
  });

  it("excludes the queued slot five", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    const user = userEvent.setup({ document: globalThis.document });

    const { getByRole } = render(
      <ImageGenerationPanel
        productId="prod_1"
        revisionId="rev_1"
        imageGeneration={partialWithWaitingSlot()}
      />
    );

    await user.click(getByRole("button", { name: "排除这张" }));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/slots/slot_5"),
      expect.objectContaining({ method: "PATCH", body: expect.stringContaining("exclude") })
    );
  });

  it("adjusts output count with +/- buttons", async () => {
    globalThis.fetch = vi.fn();
    const user = userEvent.setup({ document: globalThis.document });

    const { getByRole, getByText } = render(
      <ImageGenerationPanel
        productId="prod_1"
        revisionId="rev_1"
        imageGeneration={readyModel()}
      />
    );

    await user.click(getByRole("button", { name: "减少" }));
    expect(getByText("3")).toBeInTheDocument();
    await user.click(getByRole("button", { name: "增加" }));
    await user.click(getByRole("button", { name: "增加" }));
    expect(getByText("5")).toBeInTheDocument();
  });

  it("renders not_started panel with category, thumbnails, and start button", async () => {
    globalThis.fetch = vi.fn();

    const { getByRole, getByText } = render(
      <ImageGenerationPanel
        productId="prod_1"
        revisionId="rev_1"
        imageGeneration={readyModel()}
      />
    );

    expect(getByText("electronics.smartphone")).toBeInTheDocument();
    expect(getByRole("button", { name: "开始洗图" })).toBeInTheDocument();
    expect(getByRole("button", { name: "减少" })).toBeInTheDocument();
    expect(getByRole("button", { name: "增加" })).toBeInTheDocument();
  });

  it("renders partial progress with slot cards and action buttons", async () => {
    globalThis.fetch = vi.fn();

    const { getAllByRole, getByRole, getByText } = render(
      <ImageGenerationPanel
        productId="prod_1"
        revisionId="rev_1"
        imageGeneration={partialModel()}
      />
    );

    expect(getByText(/已生成 4\/5/)).toBeInTheDocument();
    expect(getByRole("button", { name: "重新生成这张" })).toBeInTheDocument();
    expect(getAllByRole("button", { name: "放大" })).toHaveLength(4);
  });

  it("renders a thumbnail only for a successful slot with a durable local URL", () => {
    const model = partialModel();
    const unsafe = {
      ...model,
      slots: model.slots.map((slot) => slot.slotId === "slot_4"
        ? { ...slot, localUrl: "https://provider.test/transient.png" }
        : slot)
    } satisfies ImageGenerationViewV1;

    const { queryByRole, getAllByRole } = render(
      <ImageGenerationPanel productId="prod_1" revisionId="rev_1" imageGeneration={unsafe} />
    );

    expect(queryByRole("img", { name: "第 4 张" })).not.toBeInTheDocument();
    expect(getAllByRole("img").every((image) => !image.getAttribute("src")?.includes("provider.test"))).toBe(true);
  });
});
