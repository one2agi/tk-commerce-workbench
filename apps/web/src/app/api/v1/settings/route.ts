import type { SettingsService } from "../../../../server/services/settings-service";
import { rejectNonLoopback } from "../../../../server/auth/loopback";

export function createGetHandler(dependencies: { service: SettingsService }) {
  return async function get(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    return Response.json(dependencies.service.get());
  };
}

export async function GET(request: Request): Promise<Response> {
  const { getServerServices } = await import("../../../../server/composition");
  return createGetHandler({ service: (await getServerServices()).settings })(request);
}
