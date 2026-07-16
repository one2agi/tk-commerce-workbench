import { describe, expect, it, vi } from "vitest";
import { RetryableJobError, type ClaimedWorkerJob, type WorkerExecutionContext } from "../runtime/worker-loop.js";
import { createStagingCleanupHandler } from "./staging-cleanup.js";

const job: ClaimedWorkerJob = { jobId: "cleanup-1", kind: "staging_cleanup", payload: { revisionId: "rev-1", protectedRemoteUrls: "handle" }, leaseToken: "lease", remoteTaskId: null };
const execution = { fence: { jobId: "cleanup-1", owner: "worker", leaseToken: "lease" }, signal: new AbortController().signal, assertLease: vi.fn(), persistRemoteTask: vi.fn(), scheduleCompensation: vi.fn() } satisfies WorkerExecutionContext;

describe("staging TTL cleanup", () => {
  it("defers while the encrypted staging handle is still active", async () => {
    const handler = createStagingCleanupHandler({ staging: { stage: vi.fn(), release: vi.fn() }, codec: { protect: vi.fn(), unprotect: () => ({ remoteUrls: ["secret-url"], expiresAt: "2026-07-16T01:00:00Z" }) }, audit: { append: vi.fn() }, now: () => new Date("2026-07-16T00:00:00Z") });
    await expect(handler(job, execution)).rejects.toEqual(expect.objectContaining<Partial<RetryableJobError>>({ code: "staging_ttl_active", delayMs: 3_600_000 }));
  });

  it("records expired without claiming a fresh runtime deleted the remote upload", async () => {
    const release = vi.fn();
    const audit = { append: vi.fn() };
    const handler = createStagingCleanupHandler({ staging: { stage: vi.fn(), release }, codec: { protect: vi.fn(), unprotect: () => ({ remoteUrls: ["secret-url"], expiresAt: "2026-07-16T01:00:00Z" }) }, audit, now: () => new Date("2026-07-16T01:00:01Z") });
    await expect(handler(job, execution)).resolves.toEqual({ next: [] });
    expect(release).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ state: "expired" }) }));
  });
});
