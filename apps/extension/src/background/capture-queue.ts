import type { LocalDetailCapture } from "../content/detail-parser.js";

export interface SelectedCaptureItem {
  readonly sourceItemId: string;
  readonly sourceUrl: string;
  readonly title: string;
}

export interface CaptureTabPort {
  open(url: string): Promise<number>;
  waitUntilComplete(tabId: number): Promise<void>;
  capture(tabId: number): Promise<LocalDetailCapture>;
  close(tabId: number): Promise<void>;
}

export type CaptureProgress = Readonly<{
  state: "capturing" | "item_succeeded" | "item_failed" | "completed";
  total: number;
  current: number;
  succeeded: number;
  failed: number;
  sourceItemId?: string;
  reason?: string;
}>;

export type CaptureBatchResult = Readonly<{
  batchId: string;
  captures: ReadonlyArray<LocalDetailCapture>;
  failures: ReadonlyArray<{
    item: SelectedCaptureItem;
    reason: string;
  }>;
}>;

export function createDetailCaptureQueue(port: CaptureTabPort) {
  return {
    async captureBatch(
      input: {
        batchId: string;
        items: ReadonlyArray<SelectedCaptureItem>;
      },
      report: (progress: CaptureProgress) => void = () => undefined
    ): Promise<CaptureBatchResult> {
      const captures: LocalDetailCapture[] = [];
      const failures: Array<{ item: SelectedCaptureItem; reason: string }> = [];
      for (const [index, item] of input.items.entries()) {
        report({
          state: "capturing",
          total: input.items.length,
          current: index + 1,
          succeeded: captures.length,
          failed: failures.length,
          sourceItemId: item.sourceItemId
        });
        let tabId: number | null = null;
        try {
          tabId = await port.open(item.sourceUrl);
          await port.waitUntilComplete(tabId);
          const capture = await port.capture(tabId);
          assertAcceptableCapture(capture, item.sourceItemId);
          captures.push(capture);
          report({
            state: "item_succeeded",
            total: input.items.length,
            current: index + 1,
            succeeded: captures.length,
            failed: failures.length,
            sourceItemId: item.sourceItemId
          });
        } catch (error) {
          const reason = safeCaptureReason(error);
          failures.push({ item, reason });
          report({
            state: "item_failed",
            total: input.items.length,
            current: index + 1,
            succeeded: captures.length,
            failed: failures.length,
            sourceItemId: item.sourceItemId,
            reason
          });
        } finally {
          if (tabId !== null) {
            await Promise.resolve(port.close(tabId)).catch(() => undefined);
          }
        }
      }
      report({
        state: "completed",
        total: input.items.length,
        current: input.items.length,
        succeeded: captures.length,
        failed: failures.length
      });
      return { batchId: input.batchId, captures, failures };
    }
  };
}

function assertAcceptableCapture(capture: LocalDetailCapture, expectedSourceItemId: string): void {
  if (capture.sourceItemId !== expectedSourceItemId) {
    throw new Error("detail_source_item_mismatch");
  }
  if (!capture.title.trim()) throw new Error("detail_title_missing");
  if (
    capture.captureQuality !== "detail_page_complete"
    && capture.captureQuality !== "detail_page_partial"
  ) {
    throw new Error("detail_capture_unvalidated");
  }
  if (capture.mainImages.length === 0) throw new Error("detail_main_images_missing");
}

function safeCaptureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^detail_[a-z_]+$/.test(message) ? message : "detail_capture_failed";
}
