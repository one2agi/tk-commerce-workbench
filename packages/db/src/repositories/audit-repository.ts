// Audit repository. Every mutation across the DB layer SHOULD append a redacted audit
// event via this helper. The contract: redacted = true by default, payload must never
// carry secrets, headers, or raw adapter bodies — adapters redact before calling.

import { strict as assert } from "node:assert";

import { schema, type DbPool } from "../schema/index.js";

function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${t}${r}`;
}

export interface AuditInput {
  actorType: "operator" | "worker" | "system" | "adapter";
  actorId?: string;
  action: string;
  targetKind: string;
  targetId: string;
  payload?: Record<string, unknown>;
}

export class AuditRepository {
  constructor(
    private readonly pool: DbPool,
    private readonly _schema: typeof schema = schema
  ) {}

  /**
   * Append a redacted audit event. The payload MUST be already-redacted by the caller;
   * we set `redacted = true` regardless to make the policy contract explicit.
   */
  async append(input: AuditInput): Promise<string> {
    assert(input.action.length > 0, "action required");
    assert(input.targetId.length > 0, "targetId required");
    const id = newId("audit");
    await this.pool.query(
      `INSERT INTO ${schema.auditEvents}
       (id, actor_type, actor_id, action, target_kind, target_id, payload, redacted)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true)`,
      [
        id,
        input.actorType,
        input.actorId ?? null,
        input.action,
        input.targetKind,
        input.targetId,
        JSON.stringify(input.payload ?? {})
      ]
    );
    return id;
  }
}
