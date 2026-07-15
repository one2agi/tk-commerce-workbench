import type { ProductService } from "../../../../../server/services/product-service";
import { rejectNonLoopback } from "../../../../../server/auth/loopback";

type Context = { params: Promise<{ productId: string }> };

export function createGetHandler(dependencies: { service: ProductService }) {
  return async function get(_request: Request, context: Context): Promise<Response> {
    const rejected = rejectNonLoopback(_request);
    if (rejected) return rejected;
    const { productId } = await context.params;
    const product = await dependencies.service.get(productId);
    return product
      ? Response.json(product)
      : Response.json({ error: "product_not_found" }, { status: 404 });
  };
}

export async function GET(request: Request, context: Context): Promise<Response> {
  const { getServerServices } = await import("../../../../../server/composition");
  return createGetHandler({ service: (await getServerServices()).products })(request, context);
}
