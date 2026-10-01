import type { WriteRecordsOverviewV1 } from "@tk/contracts/read-models";
import { rejectNonLoopback } from "../../../../server/auth/loopback";

export interface SyncStatusPort { list(): Promise<WriteRecordsOverviewV1> }

export function createGetHandler(dependencies: { syncs: SyncStatusPort }) {
  return async function get(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    return Response.json(await dependencies.syncs.list());
  };
}

export async function GET(request: Request): Promise<Response> {
  const { getServerServices } = await import("../../../../server/composition");
  return createGetHandler({ syncs: (await getServerServices()).syncs })(request);
}
