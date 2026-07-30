// RED — phase 4 (source scan)
// Wave 1 Web must never import @tk/db / @tk/adapters, and must never ship
// "发布 TikTok" / "认领到采集箱" / Miaoshou-edit affordances. This test walks
// the app source tree to assert both invariants statically.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(__dirname, "..", "..");

const FORBIDDEN_IMPORTS = ["@tk/db", "@tk/adapters"];

// Forbidden *affordances* — only fire when the token appears in user-action
// context (button / link / onClick). Plain dt/dd status labels are allowed.
const FORBIDDEN_AFFORDANCE_REGEX = [
  /<button[^>]*>[^<]*(?:发布\s*TikTok|发布到\s*TikTok|认领到采集箱|编辑妙手详情|妙手编辑\s*\S{0,5}\s*\S{0,3})[^<]*<\/button>/i,
  />[^<]*(?:发布\s*TikTok|发布到\s*TikTok|认领到采集箱|编辑妙手详情)[^<]*</i
];
const FORBIDDEN_LINK_TEXT = [/TikTok/, /采集箱/];
const FORBIDDEN_DRAG_STATE_ENTRY = [
  /\bdraggable\s*=/i,
  /\bon(?:Drag(?:Start|End|Enter|Leave|Over|Capture)?|Drop(?:Capture)?)\s*=/
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      out.push(...walk(p));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

// Only scan production source (components + app pages + lib). Skip test files
// and the scan spec itself — those legitimately mention the forbidden tokens
// as part of their assertions.
function isProductionSource(file: string): boolean {
  const rel = relative(SRC_ROOT, file);
  if (rel.includes(".test.")) return false;
  return (
    rel.startsWith("components" + "/") ||
    rel.startsWith("app" + "/") ||
    rel.startsWith("lib" + "/")
  );
}

describe("web app source invariants", () => {
  it("never imports @tk/db or @tk/adapters", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (!isProductionSource(file)) continue;
      const src = readFileSync(file, "utf8");
      for (const mod of FORBIDDEN_IMPORTS) {
        if (new RegExp(`from\\s+["']${mod}["']`).test(src)) {
          offenders.push(`${file} imports ${mod}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never renders forbidden publish / claim / Miaoshou-edit affordances", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (!isProductionSource(file)) continue;
      const src = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN_AFFORDANCE_REGEX) {
        if (pattern.test(src)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("sidebar / nav never mentions TikTok or 采集箱", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (!isProductionSource(file)) continue;
      const rel = relative(SRC_ROOT, file);
      if (!/(?:^|\/)(?:navigation|sidebar|nav)(?:\/|\.|-)/i.test(rel)) continue;
      const src = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN_LINK_TEXT) {
        if (pattern.test(src)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never exposes drag gestures that can change product state", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (!isProductionSource(file)) continue;
      const src = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN_DRAG_STATE_ENTRY) {
        if (pattern.test(src)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
