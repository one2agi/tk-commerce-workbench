import "@testing-library/jest-dom/vitest";
// @ts-expect-error The workspace provides the jsdom runtime without @types/jsdom.
import { JSDOM } from "jsdom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { ImageGenerationTemplateViewV1 } from "@tk/contracts/read-models";
import { templateId } from "@tk/contracts/ids";
import { ImageGenerationTemplateManager } from "./image-generation-template-manager";

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

function makeRecipe(overrides = {}) {
  return {
    inputCounts: { default: 2, min: 1, max: 6 },
    outputCounts: { default: 4, min: 1, max: 8 },
    mustPreserve: [],
    visualDirection: "clean white background",
    forbidden: [],
    roles: [
      { key: "hero", instruction: "Primary hero shot of the product" },
      { key: "detail", instruction: "Close-up detail view" }
    ],
    ...overrides
  };
}

function activeTemplate(): ImageGenerationTemplateViewV1 {
  return {
    templateId: templateId("tpl_1"),
    name: "Women's Hat",
    categoryKey: "women.hat",
    parentCategoryKey: "women",
    version: 2,
    lifecycleState: "active",
    recipe: makeRecipe(),
    activatedAt: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-06-15T00:00:00.000Z"
  };
}

function draftTemplate(): ImageGenerationTemplateViewV1 {
  return {
    templateId: templateId("tpl_2"),
    name: "Men's Shirt",
    categoryKey: "men.shirt",
    parentCategoryKey: "men",
    version: 1,
    lifecycleState: "draft",
    recipe: makeRecipe(),
    activatedAt: null,
    createdAt: "2026-07-20T00:00:00.000Z"
  };
}

function archivedTemplate(): ImageGenerationTemplateViewV1 {
  return {
    templateId: templateId("tpl_3"),
    name: "Kids Shoes",
    categoryKey: "kids.shoes",
    parentCategoryKey: "kids",
    version: 1,
    lifecycleState: "archived",
    recipe: makeRecipe(),
    activatedAt: null,
    createdAt: "2026-05-01T00:00:00.000Z"
  };
}

describe("ImageGenerationTemplateManager", () => {
  it("shows lifecycle actions without role restrictions", () => {
    const { getAllByRole } = render(<ImageGenerationTemplateManager items={[activeTemplate(), draftTemplate(), archivedTemplate()]} />);
    const buttons = getAllByRole("button");
    const buttonNames = buttons.map(b => b.textContent);
    expect(buttonNames).toContain("测试提示词");
    expect(buttonNames).toContain("启用此版本");
    expect(buttonNames).toContain("恢复为新草稿");
  });

  it("shows create template button", () => {
    const { getByRole } = render(<ImageGenerationTemplateManager items={[]} />);
    expect(getByRole("button", { name: "新建模板" })).toBeVisible();
  });

  it("shows archived templates with restore action", () => {
    const { getByRole } = render(<ImageGenerationTemplateManager items={[archivedTemplate()]} />);
    expect(getByRole("button", { name: "恢复为新草稿" })).toBeVisible();
  });

  it("calls prompt-test API when 测试提示词 is clicked", async () => {
    const user = userEvent.setup({ document: globalThis.document });
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ prompts: [] })
    });

    const { getByRole } = render(<ImageGenerationTemplateManager items={[draftTemplate()]} />);

    await user.click(getByRole("button", { name: "测试提示词" }));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toContain("/prompt-test");
    expect(opts.method).toBe("POST");
  });

  it("calls activate API when 启用此版本 is clicked", async () => {
    const user = userEvent.setup({ document: globalThis.document });
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({})
    });

    const { getByRole } = render(<ImageGenerationTemplateManager items={[draftTemplate()]} />);

    await user.click(getByRole("button", { name: "启用此版本" }));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toContain("/activate");
    expect(opts.method).toBe("POST");
  });

  it("calls restore API when 恢复为新草稿 is clicked", async () => {
    const user = userEvent.setup({ document: globalThis.document });
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({})
    });

    const { getByRole } = render(<ImageGenerationTemplateManager items={[archivedTemplate()]} />);

    await user.click(getByRole("button", { name: "恢复为新草稿" }));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toContain("/restore");
    expect(opts.method).toBe("POST");
  });

  it("shows template name and category", () => {
    const { getByText } = render(<ImageGenerationTemplateManager items={[activeTemplate()]} />);
    expect(getByText("Women's Hat")).toBeVisible();
    expect(getByText("women.hat")).toBeVisible();
  });

  it("shows active version badge", () => {
    const { getByText } = render(<ImageGenerationTemplateManager items={[activeTemplate()]} />);
    expect(getByText("进行中")).toBeVisible();
  });

  it("shows draft version badge", () => {
    const { getByText } = render(<ImageGenerationTemplateManager items={[draftTemplate()]} />);
    expect(getByText("草稿")).toBeVisible();
  });
});
