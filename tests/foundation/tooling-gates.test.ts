import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const WORKSPACES = [
  "apps/extension",
  "apps/web",
  "apps/worker",
  "packages/adapters",
  "packages/config",
  "packages/contracts",
  "packages/db",
  "packages/domain"
] as const;

function packageJson(relativePath = "."): {
  scripts?: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(ROOT, relativePath, "package.json"), "utf8"));
}

describe("quality gate scripts", () => {
  it("includes the browser extension in every root compile-quality gate", () => {
    const scripts = packageJson().scripts ?? {};
    for (const gate of ["build", "lint", "typecheck"] as const) {
      expect(scripts[gate], `${gate} must not exclude @tk/extension`).not.toContain("!@tk/extension");
    }
  });

  it("uses executable checks instead of echo placeholders in every workspace", () => {
    const placeholders: string[] = [];
    for (const workspace of WORKSPACES) {
      const scripts = packageJson(workspace).scripts ?? {};
      for (const gate of ["build", "lint", "typecheck"] as const) {
        const command = scripts[gate];
        if (!command || /(?:^|\s)echo(?:\s|$)/.test(command)) {
          placeholders.push(`${workspace}:${gate}=${command ?? "missing"}`);
        }
      }
    }
    expect(placeholders).toEqual([]);
  });

  it("runs database integration tests only through the dedicated integration config", () => {
    const command = packageJson("packages/db").scripts?.["test:integration"] ?? "";
    expect(command).toContain("--config vitest.integration.config.ts");
    expect(command).not.toContain("passWithNoTests");
  });
});
