export function rejectNonLoopback(request: Request): Response | null {
  const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const allowed = hostname === "localhost" || hostname === "::1" || hostname === "127.0.0.1";
  return allowed ? null : Response.json({ error: "loopback_only" }, { status: 403 });
}
