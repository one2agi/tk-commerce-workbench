export const dynamic = "force-dynamic";

export function createRuntimeHealthHandler({ launchId }) {
  return async function runtimeHealth() {
    if (!launchId) return new Response(null, { status: 503 });
    return Response.json({ launchId });
  };
}

export const GET = createRuntimeHealthHandler({
  launchId: process.env.TK_RUNTIME_LAUNCH_ID
});
