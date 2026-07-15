import type { IngestLinksV1 } from "@tk/contracts/commands";

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

export class IngestService {
  constructor(private readonly jobs: IngestJobRepository) {}

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
}
