import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { rejectNonLoopback } from "../../../../../../server/auth/loopback";
import { loadRuntimeConfig } from "../../../../../../server/composition";

type Context = { params: Promise<{ assetId: string }> };
type AssetPathPort = { localPath(assetId: string): Promise<string | null> };

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"
});

export function createGetHandler(dependencies: {
  assets: AssetPathPort;
  assetRoot: string;
  read?: (path: string) => Promise<Uint8Array>;
}) {
  return async function get(request: Request, context: Context): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    const { assetId } = await context.params;
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{1,199}$/.test(assetId)) {
      return Response.json({ error: "asset_not_found" }, { status: 404 });
    }
    const localPath = await dependencies.assets.localPath(assetId);
    if (!localPath) return Response.json({ error: "asset_not_found" }, { status: 404 });
    try {
      const unresolvedTarget = resolve(localPath);
      const [root, target, targetStat] = await Promise.all([
        realpath(resolve(dependencies.assetRoot)),
        realpath(unresolvedTarget),
        lstat(unresolvedTarget)
      ]);
      if (targetStat.isSymbolicLink() || (target !== root && !target.startsWith(`${root}${sep}`))) {
        return Response.json({ error: "asset_not_found" }, { status: 404 });
      }
      const contentType = CONTENT_TYPES[extname(target).toLowerCase()];
      if (!contentType) return Response.json({ error: "unsupported_asset_type" }, { status: 415 });
      const body = await (dependencies.read ?? readFile)(target);
      return new Response(body as BodyInit, { headers: {
        "content-type": contentType,
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff"
      } });
    } catch {
      return Response.json({ error: "asset_not_found" }, { status: 404 });
    }
  };
}

export async function GET(request: Request, context: Context): Promise<Response> {
  const { getServerServices } = await import("../../../../../../server/composition");
  return createGetHandler({
    assets: { localPath: (assetId) => (getServerServices()).then((services) => services.products.assetLocalPath(assetId)) },
    assetRoot: loadRuntimeConfig().assetRoot
  })(request, context);
}
