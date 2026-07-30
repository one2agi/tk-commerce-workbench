// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { build } from "vite";

const extensionRoot = fileURLToPath(new URL("../", import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), "tk-extension-build-"));

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("Chrome extension build", () => {
  it("emits every file referenced by the MV3 manifest", async () => {
    await build({
      root: extensionRoot,
      configFile: join(extensionRoot, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir }
    });
    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as {
      permissions: string[];
      background: { service_worker: string };
      content_scripts: Array<{ js: string[] }>;
      options_ui: { page: string };
      action: { default_popup: string };
    };
    const referenced = [
      manifest.background.service_worker,
      ...manifest.content_scripts.flatMap((script) => script.js),
      manifest.options_ui.page,
      manifest.action.default_popup
    ];
    expect(manifest.permissions).toContain("scripting");
    expect(referenced).toEqual([
      "background.js",
      "page-context.js",
      "content.js",
      "options.html",
      "popup.html"
    ]);
    expect(referenced.every((file) => existsSync(join(outDir, file)))).toBe(true);
  });
});
