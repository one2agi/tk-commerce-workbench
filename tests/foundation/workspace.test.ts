import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workspace baseline", () => {
  it("pins Node 22 and pnpm 9", async () => {
    const root = JSON.parse(await readFile("package.json", "utf8"));
    expect(root.engines.node).toBe(">=22 <23");
    expect(root.packageManager).toBe("pnpm@9.15.9");
  });

  it("contains all eight workspace packages", async () => {
    const yaml = await readFile("pnpm-workspace.yaml", "utf8");
    expect(yaml).toContain("apps/*");
    expect(yaml).toContain("packages/*");
  });
});
