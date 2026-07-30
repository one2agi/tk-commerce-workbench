export const dynamic = "force-dynamic";

function canvasBaseUrlKind(value) {
  if (!value) return "missing";
  try {
    const host = new URL(value).hostname.toLowerCase();
    return /^(127\.0\.0\.1|localhost|::1|\[::1\])$/.test(host) ? "loopback" : "remote";
  } catch {
    return "remote";
  }
}

export function createRuntimeHealthHandler({
  launchId,
  adapterMode = "mock",
  canvasBaseUrlKind: configuredCanvasBaseUrlKind,
  canvasWorkflowName = ""
}) {
  return async function runtimeHealth() {
    if (!launchId) return new Response(null, { status: 503 });
    return Response.json({
      launchId,
      adapterMode: adapterMode === "live" ? "live" : "mock",
      canvasBaseUrlKind: configuredCanvasBaseUrlKind ?? canvasBaseUrlKind(process.env.CANVAS_BASE_URL),
      canvasWorkflowName
    });
  };
}

export const GET = createRuntimeHealthHandler({
  launchId: process.env.TK_RUNTIME_LAUNCH_ID,
  adapterMode: process.env.EXTERNAL_ADAPTER_MODE,
  canvasWorkflowName: process.env.CANVAS_WORKFLOW_NAME ?? ""
});
