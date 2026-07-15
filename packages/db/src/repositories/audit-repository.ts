// Audit repository. Every mutation across the DB layer SHOULD append a redacted audit
// event via this helper. The contract: redacted = true by default, payload must never
// carry secrets, headers, or raw adapter bodies — adapters redact before calling.

import { strict as assert } from "node:assert";

import { schema, type DbPool } from "../schema/index.js";
import type { PoolClient } from "pg";

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

export interface TransactionAuditMetadata {
  actorType: AuditInput["actorType"];
  actorId?: string;
  action: string;
  targetKind: string;
  payload?: Record<string, unknown>;
}

const FORBIDDEN_AUDIT_KEY = /(?:token|secret|authorization|headers?|raw[_-]?body|cookie|signature)/i;

export function assertSafeAuditPayload(payload: Record<string, unknown>): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert(!FORBIDDEN_AUDIT_KEY.test(key), `audit payload key '${key}' is forbidden`);
      visit(child);
    }
  };
  visit(payload);
}

export async function appendAuditInTransaction(
  client: Pick<PoolClient, "query">,
  audit: TransactionAuditMetadata,
  targetId: string
): Promise<string> {
  assert(audit.action.length > 0, "audit action required");
  assert(audit.targetKind.length > 0, "audit targetKind required");
  const payload = audit.payload ?? {};
  assertSafeAuditPayload(payload);
  const id = newId("audit");
  await client.query(
    `INSERT INTO ${schema.auditEvents}
     (id, actor_type, actor_id, action, target_kind, target_id, payload, redacted)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true)`,
    [id, audit.actorType, audit.actorId ?? null, audit.action, audit.targetKind, targetId, JSON.stringify(payload)]
  );
  return id;
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
    return appendAuditInTransaction(this.pool, input, input.targetId);
  }
}
