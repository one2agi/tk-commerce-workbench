// @vitest-environment node
// scan-store relies on a DOM-like root. We provide a minimal in-memory DOM stub
// that captures querySelectorAll, appendChild, and setAttribute behavior.
import { describe, expect, it } from "vitest";
import {
  createScanStore,
  type ScanStoreListener
} from "./scan-store.js";

interface StubElement {
  tagName: string;
  parent: StubElement | null;
  children: StubElement[];
  attrs: Record<string, string>;
  text: string;
  textContent: string;
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
    textContent: "",
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

describe("scan-store", () => {
  it("creates one selectable product on a 1688 detail page", () => {
    const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "location", {
      value: new URL("https://detail.1688.com/offer/892408514788.html?forcePC=1"),
      configurable: true
    });
    Object.defineProperty(globalThis, "document", {
      value: {
        title: "工装短裤男士夏季潮牌外穿休闲运动裤宽松薄款潮流百搭五分中裤子 - 阿里巴巴"
      },
      configurable: true
    });
    try {
      const root = el("div");
      root.textContent = "整页属性和 SKU 文本不应该成为浮层标题";
      const store = createScanStore(root as unknown as HTMLElement);
      expect(store.rescan()).toEqual([{
        sourceItemId: "892408514788",
        sourceUrl: "https://detail.1688.com/offer/892408514788.html",
        title: "工装短裤男士夏季潮牌外穿休闲运动裤宽松薄款潮流百搭五分中裤子"
      }]);
    } finally {
      if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
      else Reflect.deleteProperty(globalThis, "location");
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });

  it("supports the direct and render-key card shapes used by the local 1688 collector", () => {
    const root = el("div");
    const direct = el("a");
    direct.attrs["class"] = "search-offer-wrapper";
    direct.attrs["href"] = "https://detail.1688.com/offer/111111111111.html";
    root.appendChild(direct);
    const rendered = el("div");
    rendered.attrs["class"] = "search-offer-wrapper";
    rendered.attrs["data-renderkey"] = "offer-2";
    const similar = el("a");
    similar.attrs["href"] = "https://s.1688.com/similar_search.html?offerIds=222222222222";
    rendered.appendChild(similar);
    root.appendChild(rendered);

    const store = createScanStore(root as unknown as HTMLElement);
    store.rescan();
    expect(store.snapshot().map((card) => card.sourceItemId)).toEqual([
      "111111111111",
      "222222222222"
    ]);
  });

  it("parses visible cards from a frozen DOM fixture", () => {
    const root = buildFixtureDom();
    const store = createScanStore(root as unknown as HTMLElement);
    store.rescan();
    const cards = store.snapshot();
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.sourceItemId).sort()).toEqual([
      "111111111111",
      "222222222222",
      "333333333333"
    ]);
  });

  it("only scans lazily loaded cards after the operator manually rescans", () => {
    const root = buildFixtureDom();
    const store = createScanStore(root as unknown as HTMLElement);
    store.rescan();
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
    expect(store.snapshot()).toHaveLength(3);
    expect(store.rescan()).toHaveLength(5);
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
    store.rescan();
    const cards = store.snapshot();
    const ids = cards.map((c) => c.sourceItemId);
    expect(ids.filter((id) => id === "111111111111")).toHaveLength(1);
    expect(cards).toHaveLength(3);
  });

  it("persists selection across re-render (DOM rebuild)", () => {
    const root = buildFixtureDom();
    const store = createScanStore(root as unknown as HTMLElement);
    store.rescan();
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
    store.rescan();
    store.select("111111111111", true);
    store.select("333333333333", true);
    const batch = store.selectedBatch();
    const ids = batch.map((b) => b.sourceItemId).sort();
    expect(ids).toEqual(["111111111111", "333333333333"]);
    expect(ids).not.toContain("222222222222");
  });

  it("bulk-selects and clears the current scanned set without submitting", () => {
    const root = buildFixtureDom();
    const store = createScanStore(root as unknown as HTMLElement);
    store.rescan();
    store.selectAll();
    expect(store.selectedBatch().map((card) => card.sourceItemId).sort()).toEqual([
      "111111111111",
      "222222222222",
      "333333333333"
    ]);
    store.clearSelection();
    expect(store.selectedBatch()).toEqual([]);
  });

  it("notifies listeners on changes", () => {
    const root = buildFixtureDom();
    const store = createScanStore(root as unknown as HTMLElement);
    const seen: number[] = [];
    const listener: ScanStoreListener = (cards) => seen.push(cards.length);
    store.subscribe(listener);
    store.rescan();
    store.select("111111111111", true);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[seen.length - 1]).toBe(3);
  });
});
