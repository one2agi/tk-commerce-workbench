import { externalFailure, type ApprovalSnapshotV1 } from "@tk/contracts";

export type MiaoshouEditableSku = Readonly<{
  itemNum: string;
  price: number;
  stock: number;
  weight: number;
  attributes: Readonly<Record<string, string>>;
  imgUrl?: string;
}>;

export type MiaoshouEditableDetail = Readonly<{
  title: string;
  itemNum?: string;
  notesText: string;
  notes: string;
  price: number;
  stock: number;
  weight: number;
  packageLength?: number;
  packageWidth?: number;
  packageHeight?: number;
  imgUrls: readonly string[];
  sourceAttrs: ReadonlyArray<Readonly<{ name: string; value: string }>>;
  skuMap: Readonly<Record<string, MiaoshouEditableSku>>;
}>;

function decimal(value: string, field: string): number {
  const text = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
    throw externalFailure("needs_input", `miaoshou.edit_invalid_${field}`, `Approved ${field} is invalid`);
  }
  const number = Number(text);
  if (!Number.isFinite(number)) {
    throw externalFailure("needs_input", `miaoshou.edit_invalid_${field}`, `Approved ${field} is invalid`);
  }
  return number;
}

/** Convert the approved integer-minor amount to the API major-unit number exactly once. */
function moneyMajor(amountMinor: string, field: string): number {
  const text = amountMinor.trim();
  if (!/^\d+$/.test(text)) {
    throw externalFailure("needs_input", `miaoshou.edit_invalid_${field}`, `Approved ${field} is invalid`);
  }
  const minor = BigInt(text);
  const majorText = `${minor / 100n}.${(minor % 100n).toString().padStart(2, "0")}`;
  const number = Number(majorText);
  if (!Number.isFinite(number) || minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw externalFailure("needs_input", `miaoshou.edit_invalid_${field}`, `Approved ${field} is outside the supported range`);
  }
  return number;
}

function remoteUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export function mapApprovalSnapshotToMiaoshouEdit(
  snapshot: ApprovalSnapshotV1,
  orderedRemoteAssetUrls: string[]
): MiaoshouEditableDetail {
  if (
    orderedRemoteAssetUrls.length !== snapshot.orderedFinalAssetIds.length
    || orderedRemoteAssetUrls.some((url) => !remoteUrl(url))
    || new Set(orderedRemoteAssetUrls).size !== orderedRemoteAssetUrls.length
  ) {
    throw externalFailure(
      "needs_input",
      "miaoshou.edit_asset_order_mismatch",
      "Approved images must have one unique remote URL in the approved order"
    );
  }
  if (snapshot.priceWire.currency !== snapshot.currency || snapshot.skus.some((sku) => sku.priceWire.currency !== snapshot.currency)) {
    throw externalFailure("needs_input", "miaoshou.edit_currency_mismatch", "Approved prices must use one currency");
  }

  const urlByAsset = new Map(snapshot.orderedFinalAssetIds.map((id, index) => [String(id), orderedRemoteAssetUrls[index]!]));
  const weight = decimal(snapshot.weightKg, "weight");
  const skuMap = Object.fromEntries(snapshot.skus.map((sku) => {
    const imageUrl = sku.assetIds.map((id) => urlByAsset.get(String(id))).find((url): url is string => Boolean(url));
    return [sku.skuId, Object.freeze({
      itemNum: sku.skuId,
      price: moneyMajor(sku.priceWire.amountMinor, "sku_price"),
      stock: sku.stock,
      weight,
      attributes: Object.freeze({ ...sku.attributes }),
      ...(imageUrl ? { imgUrl: imageUrl } : {})
    })];
  }));
  const dimensions = snapshot.dimensions;

  return Object.freeze({
    title: snapshot.title,
    ...(snapshot.itemNumber ? { itemNum: snapshot.itemNumber } : {}),
    notesText: snapshot.description,
    notes: snapshot.description,
    price: moneyMajor(snapshot.priceWire.amountMinor, "price"),
    stock: snapshot.stock,
    weight,
    ...(dimensions ? {
      packageLength: decimal(dimensions.lengthCm, "length"),
      packageWidth: decimal(dimensions.widthCm, "width"),
      packageHeight: decimal(dimensions.heightCm, "height")
    } : {}),
    imgUrls: Object.freeze([...orderedRemoteAssetUrls]),
    sourceAttrs: Object.freeze(snapshot.attributes.map((attribute) => Object.freeze({ ...attribute }))),
    skuMap: Object.freeze(skuMap)
  });
}
