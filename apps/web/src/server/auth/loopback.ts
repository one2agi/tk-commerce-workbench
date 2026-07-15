export function rejectNonLoopback(request: Request): Response | null {
  const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const allowed = hostname === "localhost" || hostname === "::1" || hostname === "127.0.0.1";
  return allowed ? null : Response.json({ error: "loopback_only" }, { status: 403 });
}

export function rejectUnsafeBrowserMutation(request: Request): Response | null {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const origin = request.headers.get("origin");
  if (contentType !== "application/json" || !origin) {
    return Response.json({ error: "same_origin_json_required" }, { status: 403 });
  }
  try {
    return new URL(origin).origin === new URL(request.url).origin
      ? null
      : Response.json({ error: "same_origin_json_required" }, { status: 403 });
  } catch {
    return Response.json({ error: "same_origin_json_required" }, { status: 403 });
  }
}
