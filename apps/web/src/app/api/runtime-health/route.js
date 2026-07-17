import { timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";

function tokensMatch(actual, expected) {
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes);
}

export function createRuntimeHealthHandler({ healthToken }) {
  return async function runtimeHealth(request) {
    const supplied = request.headers.get("x-tk-runtime-health-token");
    if (!tokensMatch(supplied, healthToken)) {
      return new Response(null, { status: 404 });
    }
    return Response.json({ token: healthToken });
  };
}

export const GET = createRuntimeHealthHandler({
  healthToken: process.env.TK_RUNTIME_HEALTH_TOKEN
});
