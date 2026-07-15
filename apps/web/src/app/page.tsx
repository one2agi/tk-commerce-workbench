import { ProductWorkbench } from "../components/products/product-workbench";
import { fixtures } from "../lib/fixtures";

export default function HomePage() {
  return <ProductWorkbench initialItems={fixtures.productPool} />;
}