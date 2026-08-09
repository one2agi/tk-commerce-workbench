import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PromptTestResults } from "./image-generation-template-manager";

describe("PromptTestResults", () => {
  it("shows generated prompt text and the Planner cost boundary", () => {
    const html = renderToStaticMarkup(<PromptTestResults prompts={[
      {
        slot: 1,
        role: "hero",
        prompt: "A clean product hero shot",
        mustPreserve: ["真实商品"],
        forbidden: ["改变颜色"]
      }
    ]} />);

    expect(html).toContain("A clean product hero shot");
    expect(html).toContain("不会创建图片任务");
    expect(html).toContain("会产生提示词模型费用");
  });
});
