import type { ProductPoolItemV1 } from "@tk/contracts/read-models";

import { ProductWorkbench } from "../../components/products/product-workbench";
import { getServerServices } from "../../server/composition";

export const dynamic = "force-dynamic";

export function renderProductsPage(data: { items: ProductPoolItemV1[] }) {
  return <ProductWorkbench initialItems={data.items} />;
}

export default async function ProductsPage() {
  return renderProductsPage(await (await getServerServices()).products.list());
}
