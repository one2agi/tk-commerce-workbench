import { z } from "zod";

import type { TaskService } from "../../../../../../server/services/task-service";
import { rejectNonLoopback } from "../../../../../../server/auth/loopback";

const TaskActionBody = z.object({ action: z.enum(["pause", "resume", "cancel", "retry"]) });
type Context = { params: Promise<{ taskId: string }> };

export function createPostHandler(dependencies: { service: TaskService }) {
  return async function post(request: Request, context: Context): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    const parsed = TaskActionBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
    const { taskId } = await context.params;
    const changed = await dependencies.service.act(taskId, parsed.data.action);
    return changed
      ? Response.json({ taskId, action: parsed.data.action, accepted: true }, { status: 202 })
      : Response.json({ error: "task_action_not_allowed" }, { status: 409 });
  };
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { getServerServices } = await import("../../../../../../server/composition");
  return createPostHandler({ service: (await getServerServices()).tasks })(request, context);
}
