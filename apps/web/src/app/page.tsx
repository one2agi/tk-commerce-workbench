import { ProductWorkbench } from "../components/products/product-workbench";
import { getServerServices } from "../server/composition";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { items } = await (await getServerServices()).products.list();
  return <ProductWorkbench initialItems={items} />;
}
