// @vitest-environment node
// scan-store relies on a DOM + MutationObserver. We provide a minimal in-memory
// DOM stub that captures the same behavior: querySelectorAll, appendChild,
// setAttribute, and an emit()-based MutationObserver.
import { describe, expect, it } from "vitest";
import {
  createScanStore,
  type ScanStoreListener,
  type ScannedCard
} from "./scan-store.js";

interface StubElement {
  tagName: string;
  parent: StubElement | null;
  children: StubElement[];
  attrs: Record<string, string>;
  text: string;
  _observer: Array<() => void> | null;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: StubElement): StubElement;
  querySelectorAll(sel: string): StubElement[];
  querySelector(sel: string): StubElement | null;
}

function el(tag: string): StubElement {
  const node: StubElement = {
    tagName: tag.toUpperCase(),
    parent: null,
    children: [],
    attrs: {},
    text: "",
    _observer: null,
    setAttribute(name, value) {
      node.attrs[name] = value;
    },
    getAttribute(name) {
      const v = node.attrs[name];
      return v ?? null;
    },
    appendChild(child) {
      child.parent = node;
      node.children.push(child);
      node._observer?.forEach((cb) => cb());
      return child;
    },
    querySelectorAll(sel) {
      const out: StubElement[] = [];
      // Parse compound selector: e.g. ".offer-card[data-card-id]"
      const parts: Array<{ cls?: string; attr?: string; attrVal?: string }> = [];
      let rest = sel;
      while (rest.length > 0) {
        if (rest.startsWith(".")) {
          const m = /^(\S+?)(?=[.[]|$)/.exec(rest);
          const cls = m && m[1] ? m[1].slice(1) : "";
          parts.push({ cls });
          rest = rest.slice(1 + cls.length);
        } else if (rest.startsWith("[")) {
          const close = rest.indexOf("]");
          const inside = close > 0 ? rest.slice(1, close) : "";
          rest = close > 0 ? rest.slice(close + 1) : "";
          const m = /^([^=\]]+)(?:="([^"]*)")?$/.exec(inside);
          if (!m) continue;
          parts.push({ attr: m[1], attrVal: m[2] });
        } else {
          const m = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest);
          if (!m) break;
          rest = rest.slice(m[0].length);
        }
      }
      const match = (n: StubElement): boolean => {
        for (const p of parts) {
          if (p.cls && !(n.attrs["class"] ?? "").split(/\s+/).includes(p.cls)) return false;
          if (p.attr) {
            const got = n.attrs[p.attr];
            if (p.attrVal === undefined) {
              if (got === undefined) return false;
            } else if (got !== p.attrVal) {
              return false;
            }
          }
        }
        return true;
      };
      const walk = (n: StubElement) => {
        for (const c of n.children) {
          if (match(c)) out.push(c);
          walk(c);
        }
      };
      walk(node);
      return out;
    },
    querySelector(sel) {
      const all = node.querySelectorAll(sel);
      return all[0] ?? null;
    }
  };
  return node;
}

function buildFixtureDom(): StubElement {
  const root = el("div");
  root.attrs["id"] = "fixture-root";
  for (const id of ["111111111111", "222222222222", "333333333333"]) {
    const card = el("div");
    card.attrs["class"] = "offer-card";
    card.attrs["data-card-id"] = id;
    const a = el("a");
    a.attrs["href"] = `https://detail.1688.com/offer/${id}.html`;
    a.text = `card ${id}`;
    card.appendChild(a);
    root.appendChild(card);
  }
  return root;
}

// Provide a global MutationObserver stub for scan-store.ts to use.
class StubObserver {
  private cb: () => void;
  private target: StubElement;
  constructor(cb: () => void) {
    this.cb = cb;
    this.target = null as unknown as StubElement;
  }
  observe(target: StubElement) {
    this.target = target;
    if (!target._observer) target._observer = [];
    target._observer.push(() => this.cb());
  }
  disconnect() {
    if (this.target?._observer) {
      this.target._observer = this.target._observer.filter((c) => c !== this.cb);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).MutationObserver = StubObserver;

describe("scan-store", () => {
  it("parses visible cards from a frozen DOM fixture", () => {
    const root = buildFixtureDom();
    const store = createScanStore(root as unknown as HTMLElement);
    store.start();
    const cards = store.snapshot();
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.sourceItemId).sort()).toEqual([
      "111111111111",
      "222222222222",
      "333333333333"
    ]);
  });

  it("accumulates lazily loaded cards revealed by clicking load more", async () => {
    const root = buildFixtureDom();
    const store = createScanStore(root as unknown as HTMLElement);
    store.start();
    expect(store.snapshot()).toHaveLength(3);

    for (const id of ["444444444444", "555555555555"]) {
      const card = el("div");
      card.attrs["class"] = "offer-card";
      card.attrs["data-card-id"] = id;
      const a = el("a");
      a.attrs["href"] = `https://detail.1688.com/offer/${id}.html`;
      card.appendChild(a);
      root.appendChild(card);
    }
    // MutationObserver callbacks fire synchronously in this stub.
    await new Promise((r) => setTimeout(r, 10));
    const after = store.snapshot();
    expect(after).toHaveLength(5);
  });

  it("deduplicates duplicate URLs within the visible batch", () => {
    const root = buildFixtureDom();
    const dup = el("div");
    dup.attrs["class"] = "offer-card";
    dup.attrs["data-card-id"] = "111111111111";
    const dupA = el("a");
    dupA.attrs["href"] = "https://detail.1688.com/offer/111111111111.html";
    dup.appendChild(dupA);
    root.appendChild(dup);

    const store = createScanStore(root as unknown as HTMLElement);
    store.start();
    const cards = store.snapshot();
    const ids = cards.map((c) => c.sourceItemId);
    expect(ids.filter((id) => id === "111111111111")).toHaveLength(1);
    expect(cards).toHaveLength(3);
  });

  it("persists selection across re-render (DOM rebuild)", () => {
    const root = buildFixtureDom();
    const store = createScanStore(root as unknown as HTMLElement);
    store.start();
    store.select("222222222222", true);
    expect(store.selection()).toEqual(new Set(["222222222222"]));

    const newRoot = buildFixtureDom();
    store.observe(newRoot as unknown as HTMLElement);
    const cards = store.snapshot();
    expect(cards.map((c) => c.sourceItemId).sort()).toEqual([
      "111111111111",
      "222222222222",
      "333333333333"
    ]);
    expect(store.selection()).toEqual(new Set(["222222222222"]));
  });

  it("emits selection-only batches (never submits unselected)", () => {
    const root = buildFixtureDom();
    const store = createScanStore(root as unknown as HTMLElement);
    store.start();
    store.select("111111111111", true);
    store.select("333333333333", true);
    const batch = store.selectedBatch();
    const ids = batch.map((b) => b.sourceItemId).sort();
    expect(ids).toEqual(["111111111111", "333333333333"]);
    expect(ids).not.toContain("222222222222");
  });

  it("notifies listeners on changes", () => {
    const root = buildFixtureDom();
    const store = createScanStore(root as unknown as HTMLElement);
    const seen: number[] = [];
    const listener: ScanStoreListener = (cards) => seen.push(cards.length);
    store.subscribe(listener);
    store.start();
    store.select("111111111111", true);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[seen.length - 1]).toBe(3);
  });
});