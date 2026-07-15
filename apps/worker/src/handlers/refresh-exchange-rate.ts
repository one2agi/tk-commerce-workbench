import type { ExchangeRatePort } from "@tk/contracts";
import { NeedsInputError, requireFencedWrite, type LeaseFence, type WorkerHandler } from "../runtime/worker-loop.js";

export function createExchangeRateRefreshHandler(input: {
  port: ExchangeRatePort;
  repository: {
    recordProvider(value: Record<string, unknown>, fence: LeaseFence): Promise<boolean>;
    latestSuccessful(base: string, target: string): Promise<{ id: string } | null>;
    markStale(snapshotId: string, fence: LeaseFence): Promise<boolean>;
  };
  audit: { append(value: Record<string, unknown>): Promise<unknown> };
  now: () => Date;
}): WorkerHandler {
  return async (_job, execution) => {
    await input.audit.append({ action: "exchange_rate.fetch.call", targetKind: "exchange_rate", targetId: "CNY:THB", payload: {}, redacted: true });
    execution.assertLease();
    try {
      const snapshot = await input.port.fetchSnapshot({ base: "CNY", target: "THB" });
      execution.assertLease();
      requireFencedWrite(await input.repository.recordProvider({ ...snapshot, source: snapshot.source, observedAt: snapshot.observedAt, refreshedAt: input.now().toISOString() }, execution.fence));
      await input.audit.append({ action: "exchange_rate.fetch.result", targetKind: "exchange_rate", targetId: "CNY:THB", payload: { source: snapshot.source, observedAt: snapshot.observedAt }, redacted: true });
    } catch {
      const latest = await input.repository.latestSuccessful("CNY", "THB");
      if (!latest) throw new NeedsInputError("missing_exchange_rate", "No successful exchange-rate snapshot is available");
      execution.assertLease();
      requireFencedWrite(await input.repository.markStale(latest.id, execution.fence));
      await input.audit.append({ action: "exchange_rate.fetch.fallback", targetKind: "exchange_rate_snapshot", targetId: latest.id, payload: { stale: true }, redacted: true });
    }
    return { next: [] };
  };
}
