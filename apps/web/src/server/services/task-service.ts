import { jobId, productRevisionId, workerInstanceId } from "@tk/contracts/ids";
import type { ExternalFailure } from "@tk/contracts/errors";
import type { TaskCenterItemV1 } from "@tk/contracts/read-models";

import type { QueryPort } from "./product-service";

export type TaskAction = "pause" | "resume" | "cancel" | "retry";

type AuditInput = {
  actorType: "operator" | "worker" | "system" | "adapter";
  action: string;
  targetKind: string;
  targetId: string;
  payload?: Record<string, unknown>;
};

export interface TaskActionUnitOfWork {
  execute<T>(command: (transaction: {
    tasks: { act(taskId: string, action: TaskAction, reason?: string): Promise<boolean> };
    audit: { append(input: AuditInput): Promise<string> };
  }) => Promise<T>): Promise<T>;
}

function safeFailure(value: unknown): ExternalFailure | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!["retryable", "needs_input", "reconcile_required", "fatal"].includes(String(candidate.kind))) {
    return null;
  }
  return {
    kind: candidate.kind as ExternalFailure["kind"],
    code: typeof candidate.code === "string" ? candidate.code : "unknown",
    safeMessage: typeof candidate.safeMessage === "string"
      ? candidate.safeMessage
      : "Task failed"
  };
}

export class TaskService {
  constructor(
    private readonly database: QueryPort,
    private readonly actions: TaskActionUnitOfWork
  ) {}

  async list(): Promise<{ items: TaskCenterItemV1[] }> {
    const result = await this.database.query(
      `SELECT id, kind, status, attempt, max_attempts, next_attempt_at,
              pause_reason, owner, error,
              payload->>'revisionId' AS revision_id
       FROM jobs ORDER BY updated_at DESC, created_at DESC`
    );
    return {
      items: result.rows.map((row) => ({
        jobId: jobId(String(row.id)),
        kind: String(row.kind),
        status: String(row.status) as TaskCenterItemV1["status"],
        attempt: Number(row.attempt),
        maxAttempts: Number(row.max_attempts),
        nextAttemptAt: row.next_attempt_at ? new Date(String(row.next_attempt_at)).toISOString() : null,
        pauseReason: typeof row.pause_reason === "string" ? row.pause_reason : null,
        owner: typeof row.owner === "string" ? workerInstanceId(row.owner) : null,
        error: safeFailure(row.error),
        revisionId: typeof row.revision_id === "string" ? productRevisionId(row.revision_id) : null
      }))
    };
  }

  async act(taskIdValue: string, action: TaskAction, reason?: string): Promise<boolean> {
    return this.actions.execute(async ({ tasks, audit }) => {
      const normalizedReason = reason?.trim() || undefined;
      const changed = await tasks.act(taskIdValue, action, normalizedReason);
      if (!changed) return false;
      await audit.append({
        actorType: "operator",
        action: `task_${action}`,
        targetKind: "job",
        targetId: taskIdValue,
        payload: normalizedReason ? { reason: normalizedReason } : {}
      });
      return true;
    });
  }
}
