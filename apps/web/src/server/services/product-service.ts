import type {
  ApprovalPreviewV1,
  ProductFactsData,
  ProductPoolItemV1,
  ProductWorkspaceV1
} from "@tk/contracts";
import { CatalogRepository, type DbPool } from "@tk/db";
import type { ReviewWorkspaceView } from "../../components/review/review-workspace-view";

export interface QueryPort {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface ProductCatalogPort {
  listProductPool(): Promise<ProductPoolItemV1[]>;
  getProductWorkspace(productId: string): Promise<ProductWorkspaceV1 | null>;
  getApprovalPreview(productId: string): Promise<ApprovalPreviewV1 | null>;
  getProductFacts(productId: string): Promise<ProductFactsData>;
  getAssetLocalPath(assetId: string): Promise<string | null>;
}

export class ProductService {
  private readonly catalog: ProductCatalogPort;

  constructor(catalogOrDatabase: ProductCatalogPort | QueryPort) {
    if ("listProductPool" in catalogOrDatabase) {
      this.catalog = catalogOrDatabase;
    } else {
      this.catalog = new CatalogRepository(catalogOrDatabase as unknown as DbPool);
    }
  }

  async list(): Promise<{ items: ProductPoolItemV1[] }> {
    const items = await this.catalog.listProductPool();
    return { items };
  }

  async get(productIdValue: string): Promise<ProductWorkspaceV1 | null> {
    return this.catalog.getProductWorkspace(productIdValue);
  }

  async preview(productIdValue: string): Promise<ApprovalPreviewV1 | null> {
    return this.catalog.getApprovalPreview(productIdValue);
  }

  async facts(productIdValue: string): Promise<ReviewWorkspaceView["reviewFacts"]> {
    return this.catalog.getProductFacts(productIdValue);
  }

  async assetLocalPath(assetIdValue: string): Promise<string | null> {
    return this.catalog.getAssetLocalPath(assetIdValue);
  }
}
