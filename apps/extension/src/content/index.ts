import { createScanStore } from "./scan-store.js";
import { createStoreOverlay } from "./store-overlay.js";

export function bootstrapCollector(root: HTMLElement = document.body): () => void {
  const store = createScanStore(root);
  const overlay = createStoreOverlay();
  store.start();
  overlay.mount(store, root);
  return () => {
    overlay.unmount();
    store.stop();
  };
}

if (document.body) bootstrapCollector(document.body);
