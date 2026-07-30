// Content-script scan store: parses 1688 store-listing DOM into a deduplicated,
// observable card list, persists user selection across re-renders, and exposes
// the selected-only batch for the background service worker.

export interface ScannedCard {
  readonly sourceItemId: string;
  readonly sourceUrl: string;
  readonly title: string;
}

export interface ScannedCardTarget extends ScannedCard {
  readonly cardElement: HTMLElement;
  readonly imageElement: HTMLElement | null;
}

export type ScanStoreListener = (cards: ReadonlyArray<ScannedCard>) => void;

// Confirmed against the local tk-autopilot 1688 collector. 1688 has shipped
// both a direct search-offer wrapper and a data-renderkey wrapper; the final
// selector keeps compatibility with the original extension fixture.
export const CARD_SELECTORS = [
  ".search-offer-wrapper",
  "[data-renderkey][class*='search-offer']",
  ".offer-card[data-card-id]"
] as const;

export interface ScanStore {
  start(): void;
  observe(root: HTMLElement): void;
  stop(): void;
  rescan(): ReadonlyArray<ScannedCard>;
  snapshot(): ReadonlyArray<ScannedCard>;
  select(sourceItemId: string, selected: boolean): void;
  selectAll(): void;
  clearSelection(): void;
  selection(): ReadonlySet<string>;
  selectedBatch(): ReadonlyArray<ScannedCard>;
  subscribe(listener: ScanStoreListener): () => void;
}

export function createScanStore(root: HTMLElement): ScanStore {
  const cardsById = new Map<string, ScannedCard>();
  const selectionById = new Set<string>();
  const listeners = new Set<ScanStoreListener>();
  let activeRoot: HTMLElement = root;

  function snapshot(): ReadonlyArray<ScannedCard> {
    return Array.from(cardsById.values()).sort((a, b) =>
      a.sourceItemId.localeCompare(b.sourceItemId)
    );
  }

  function emit(): void {
    const snap = snapshot();
    for (const l of listeners) l(snap);
  }

  function scanNode(node: ParentNode): ReadonlyArray<ScannedCard> {
    if (!("querySelectorAll" in node)) return snapshot();
    const detailId = extractDetailOfferId(currentHref());
    if (detailId) {
      cardsById.set(detailId, {
        sourceItemId: detailId,
        sourceUrl: `https://detail.1688.com/offer/${detailId}.html`,
        title: detailTitle(node, detailId)
      });
    }
    for (const target of findScannedCardTargets(node)) {
      cardsById.set(target.sourceItemId, {
        sourceItemId: target.sourceItemId,
        sourceUrl: target.sourceUrl,
        title: target.title
      });
    }
    return snapshot();
  }

  function observe(target: HTMLElement): void {
    activeRoot = target;
    scanNode(target);
  }

  return {
    start() {
      scanNode(activeRoot);
      emit();
    },
    observe(root) {
      observe(root);
      emit();
    },
    stop() {
      // Manual scan mode has no persistent page observer to disconnect.
    },
    rescan() {
      const cards = scanNode(activeRoot);
      emit();
      return cards;
    },
    snapshot() {
      return snapshot();
    },
    select(sourceItemId, selected) {
      if (selected) selectionById.add(sourceItemId);
      else selectionById.delete(sourceItemId);
      emit();
    },
    selectAll() {
      for (const card of cardsById.values()) selectionById.add(card.sourceItemId);
      emit();
    },
    clearSelection() {
      selectionById.clear();
      emit();
    },
    selection() {
      return new Set(selectionById);
    },
    selectedBatch() {
      return cardsById.size === 0 || selectionById.size === 0
        ? []
        : Array.from(selectionById)
            .map((id) => cardsById.get(id))
            .filter((c): c is ScannedCard => Boolean(c));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export function findScannedCardTargets(node: ParentNode): ReadonlyArray<ScannedCardTarget> {
  if (!("querySelectorAll" in node)) return [];
  const candidates = new Set<Element>();
  for (const selector of CARD_SELECTORS) {
    for (const element of Array.from((node as ParentNode).querySelectorAll(selector))) {
      candidates.add(element);
    }
  }
  const targets: ScannedCardTarget[] = [];
  for (const el of candidates) {
    const cardEl = el as HTMLElement;
    if (cardEl.classList?.contains("cardui-adOffer")) continue;
    const hrefs = new Set<string>();
    const ownHref = cardEl.getAttribute("href") ?? cardEl.getAttribute("data-href");
    if (ownHref) hrefs.add(ownHref);
    for (const link of Array.from(cardEl.querySelectorAll("a[href], [data-href]"))) {
      const href = link.getAttribute("href") ?? link.getAttribute("data-href");
      if (href) hrefs.add(href);
    }
    const legacyId = cardEl.getAttribute("data-card-id");
    const sourceItemId = legacyId ?? extractOfferId(hrefs);
    if (!sourceItemId) continue;
    const titleElement = cardEl.querySelector(".title-text");
    const title =
      titleElement?.textContent?.trim() || cardEl.textContent?.trim() || sourceItemId;
    targets.push({
      sourceItemId,
      sourceUrl: `https://detail.1688.com/offer/${sourceItemId}.html`,
      title,
      cardElement: cardEl,
      imageElement: findPrimaryImage(cardEl)
    });
  }
  return targets;
}

function findPrimaryImage(cardEl: HTMLElement): HTMLElement | null {
  return cardEl.querySelector("img") ?? cardEl.querySelector("[style*='background-image']");
}

function extractOfferId(hrefs: ReadonlySet<string>): string | null {
  for (const href of hrefs) {
    const direct = /detail\.1688\.com\/offer\/(\d+)\.html/i.exec(href)?.[1];
    if (direct) return direct;
    try {
      const similar = new URL(href, globalThis.location?.href).searchParams.get("offerIds");
      if (similar && /^\d+$/.test(similar)) return similar;
    } catch {
      // Ignore malformed tracking links and keep scanning the other candidates.
    }
  }
  return null;
}

function currentHref(): string {
  return globalThis.location?.href ?? "";
}

function extractDetailOfferId(href: string): string | null {
  return /detail\.1688\.com\/offer\/(\d+)\.html/i.exec(href)?.[1] ?? null;
}

function detailTitle(node: ParentNode, fallback: string): string {
  const documentTitle = cleanTitle(globalThis.document?.title, "");
  if (documentTitle) return documentTitle;
  const text =
    "textContent" in node && typeof node.textContent === "string"
      ? node.textContent.trim()
      : "";
  return cleanTitle(text, fallback);
}

function cleanTitle(value: string | undefined, fallback: string): string {
  const title = (value ?? "")
    .replace(/\s+-\s*阿里巴巴\s*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return title.slice(0, 160) || fallback;
}
