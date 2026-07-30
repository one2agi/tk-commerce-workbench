import type {
  IngestLinksV1,
  IngestLocalCaptureItemV3,
  IngestLocalCapturesResult,
  IngestLocalCapturesV3
} from "@tk/contracts/commands";

type EnqueueInput = {
  kind: string;
  businessKey: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
};

type AuditedEnqueueInput = EnqueueInput & {
  audit: {
    actorType: "operator";
    action: string;
    targetKind: string;
    payload: Record<string, unknown>;
  };
};

export interface IngestJobRepository {
  enqueue(input: AuditedEnqueueInput): Promise<string>;
}

export interface LocalCaptureRepository {
  save(input: {
    batchId: string;
    item: IngestLocalCaptureItemV3;
  }): Promise<{
    sourceItemId: string;
    productId: string;
    revisionId: string;
    created: boolean;
  }>;
}

export class IngestService {
  constructor(
    private readonly jobs: IngestJobRepository,
    private readonly captures?: LocalCaptureRepository
  ) {}

  async ingest(command: IngestLinksV1): Promise<{
    jobs: Array<{ idempotencyKey: string; jobId: string }>;
  }> {
    const queued = [] as Array<{ idempotencyKey: string; jobId: string }>;
    for (const item of command.items) {
        const jobId = await this.jobs.enqueue({
          kind: "miaoshou_collect",
          businessKey: `ingest:${item.idempotencyKey}`,
          idempotencyKey: item.idempotencyKey,
          payload: {
            version: 1,
            batchId: command.batchId,
            sourceUrl: item.sourceUrl,
            idempotencyKey: item.idempotencyKey
          },
          maxAttempts: 3,
          audit: {
            actorType: "operator",
            action: "ingest_link",
            targetKind: "job",
            payload: { batchId: command.batchId }
          }
        });
        queued.push({ idempotencyKey: item.idempotencyKey, jobId });
    }
    return { jobs: queued };
  }

  async ingestLocal(command: IngestLocalCapturesV3): Promise<IngestLocalCapturesResult> {
    if (!this.captures) throw new Error("local_capture_repository_unavailable");
    const products: IngestLocalCapturesResult["products"][number][] = [];
    const rejected: IngestLocalCapturesResult["rejected"][number][] = [];
    for (const item of command.items) {
      try {
        products.push(await this.captures.save({ batchId: command.batchId, item }));
      } catch {
        rejected.push({
          sourceItemId: item.sourceItemId,
          sourceUrl: item.sourceUrl,
          reason: "persist_failed"
        });
      }
    }
    return { accepted: products.length, products, rejected };
  }
}
