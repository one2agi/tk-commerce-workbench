// Content-script scan store: parses 1688 store-listing DOM into a deduplicated,
// observable card list, persists user selection across re-renders, and exposes
// the selected-only batch for the background service worker.

export interface ScannedCard {
  readonly sourceItemId: string;
  readonly sourceUrl: string;
  readonly title: string;
}

export type ScanStoreListener = (cards: ReadonlyArray<ScannedCard>) => void;

const CARD_SELECTOR = ".offer-card[data-card-id]";

export interface ScanStore {
  start(): void;
  observe(root: HTMLElement): void;
  stop(): void;
  snapshot(): ReadonlyArray<ScannedCard>;
  select(sourceItemId: string, selected: boolean): void;
  selection(): ReadonlySet<string>;
  selectedBatch(): ReadonlyArray<ScannedCard>;
  subscribe(listener: ScanStoreListener): () => void;
}

export function createScanStore(root: HTMLElement): ScanStore {
  const cardsById = new Map<string, ScannedCard>();
  const selectionById = new Set<string>();
  const listeners = new Set<ScanStoreListener>();
  let observer: MutationObserver | null = null;
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

  function scanNode(node: ParentNode): void {
    if (!("querySelectorAll" in node)) return;
    const els = (node as ParentNode).querySelectorAll(CARD_SELECTOR);
    for (const el of Array.from(els)) {
      const cardEl = el as HTMLElement;
      const id = cardEl.getAttribute("data-card-id");
      if (!id) continue;
      const link = cardEl.querySelector("a[href*='/offer/']") as HTMLAnchorElement | null;
      const url = link?.getAttribute("href") ?? "";
      if (!url) continue;
      const title = link?.textContent?.trim() || cardEl.textContent?.trim() || id;
      cardsById.set(id, { sourceItemId: id, sourceUrl: url, title });
    }
  }

  function observe(target: HTMLElement): void {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      scanNode(target);
      emit();
    });
    observer.observe(target, { childList: true, subtree: true });
    activeRoot = target;
    scanNode(target);
  }

  return {
    start() {
      observe(activeRoot);
      emit();
    },
    observe(root) {
      observe(root);
      emit();
    },
    stop() {
      observer?.disconnect();
      observer = null;
    },
    snapshot() {
      return snapshot();
    },
    select(sourceItemId, selected) {
      if (selected) selectionById.add(sourceItemId);
      else selectionById.delete(sourceItemId);
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