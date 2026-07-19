export function rejectNonLoopback(request: Request): Response | null {
  const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const allowed = hostname === "localhost" || hostname === "::1" || hostname === "127.0.0.1";
  return allowed ? null : Response.json({ error: "loopback_only" }, { status: 403 });
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

function loopbackAlias(hostname: string): string {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTNAMES.has(normalized) ? "loopback" : normalized;
}

function isSameLoopbackOrigin(requestUrl: string, originHeader: string): boolean {
  let reqUrl: URL;
  let oriUrl: URL;
  try {
    reqUrl = new URL(requestUrl);
    oriUrl = new URL(originHeader);
  } catch {
    return false;
  }
  if (reqUrl.protocol !== oriUrl.protocol) return false;
  if (reqUrl.port !== oriUrl.port) return false;
  return loopbackAlias(reqUrl.hostname) === loopbackAlias(oriUrl.hostname);
}

export function rejectUnsafeBrowserMutation(request: Request): Response | null {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const origin = request.headers.get("origin");
  if (contentType !== "application/json" || !origin) {
    return Response.json({ error: "same_origin_json_required" }, { status: 403 });
  }
  return isSameLoopbackOrigin(request.url, origin)
    ? null
    : Response.json({ error: "same_origin_json_required" }, { status: 403 });
}
