import type { PageContextSnapshot } from "./detail-parser.js";

type PageGlobal = {
  __tkPageContextBridgeInstalled?: boolean;
  context?: {
    result?: {
      data?: Record<string, unknown>;
    };
  };
};

type SnapshotSkuAttributes = NonNullable<PageContextSnapshot["skuAttributes"]>;
type SnapshotSkus = NonNullable<PageContextSnapshot["skus"]>;

export function read1688PageContext(globalValue: PageGlobal): PageContextSnapshot | null {
  const data = globalValue.context?.result?.data;
  if (!data) return null;
  const productTitle = fields(data.productTitle);
  const gallery = fields(data.gallery);
  const title = text(productTitle.title) || text(gallery.subject);
  const offerId = scalar(gallery.offerId);
  if (!title || !offerId) return null;

  const shopInfo = object(productTitle.shopInfo);
  const supplierName = text(shopInfo.companyName) || text(shopInfo.authCompanyName) || null;
  const mainImages = Array.isArray(gallery.mainImage)
    ? gallery.mainImage.flatMap((image) => normalizeGalleryImage(image))
    : [];
  const rootData = object(fields(data.Root).dataJson);
  const categoryId = scalar(object(rootData.offerBaseInfo).catId);
  const mainPrice = fields(data.mainPrice);
  const price = readSourcePrice(mainPrice, rootData);
  const stock = integer(object(rootData.orderParamModel).orderParam
    ? object(object(rootData.orderParamModel).orderParam).canBookedAmount
    : null)
    ?? integer(object(object(mainPrice.finalPriceModel).tradeWithoutPromotion).canBookedAmountOriginal);
  const skuResult = readSkus(rootData);
  const packageResult = readPackageFacts(fields(data.productPackInfo), skuResult.skus);
  const priceModulePresent = Object.keys(mainPrice).length > 0
    || Object.keys(object(object(rootData.orderParamModel).orderParam)).length > 0;
  const stockSupported = object(rootData.offerModelSign).isSupportStock === true
    || stock !== null;
  const isSkuOffer = rootData.isSkuOffer === true;

  return {
    offerId,
    title,
    supplierName,
    mainImages: [...new Set(mainImages)],
    attributes: findAttributes(data),
    itemNumber: null,
    category: categoryId ? `1688:${categoryId}` : null,
    sourcePriceWire: price?.sourcePriceWire ?? null,
    sourcePriceRangeWire: price?.sourcePriceRangeWire ?? null,
    sourceStock: stock,
    weightKg: packageResult.weightKg,
    dimensionsCm: packageResult.dimensionsCm,
    saleAttributes: skuResult.skuAttributes.map((attribute) => ({
      name: attribute.name,
      value: attribute.values.map((value) => value.name).join(" / ")
    })),
    skuAttributes: skuResult.skuAttributes,
    colors: optionValues(skuResult.skuAttributes, /颜色|顏色|color/iu),
    sizes: optionValues(skuResult.skuAttributes, /尺码|尺寸|規格|size/iu),
    skus: packageResult.skus,
    expectedSkuCount: skuResult.expectedSkuCount,
    fieldEvidence: {
      price: price
        ? "captured"
        : rootData.isPricePrivate === true
          ? "source_absent"
          : priceModulePresent
            ? "capture_failed"
            : "source_absent",
      stock: stock !== null
        ? "captured"
        : stockSupported
          ? "capture_failed"
          : "source_absent",
      skus: skuResult.fieldEvidence
        ?? (isSkuOffer ? "capture_failed" : "source_absent"),
      weight: packageResult.weightEvidence,
      dimensions: packageResult.dimensionsEvidence
    }
  };
}

export function installPageContextBridge(windowValue: Window = window): () => void {
  const globalState = windowValue as Window & PageGlobal;
  if (globalState.__tkPageContextBridgeInstalled) return () => undefined;
  globalState.__tkPageContextBridgeInstalled = true;
  const listener = (event: Event) => {
    const mailbox = event.target as Element | null;
    if (!mailbox || typeof mailbox.getAttribute !== "function") return;
    const requestId = mailbox.getAttribute("data-tk-context-request-id");
    if (!requestId?.startsWith("tk-context-")) return;
    const snapshot = read1688PageContext(windowValue as unknown as PageGlobal);
    mailbox.textContent = JSON.stringify(snapshot);
    const responseEvent = windowValue.document.createEvent("Event");
    responseEvent.initEvent("tk-product-context-response", false, false);
    mailbox.dispatchEvent(responseEvent);
  };
  windowValue.document.addEventListener("tk-product-context-request", listener);
  return () => {
    windowValue.document.removeEventListener("tk-product-context-request", listener);
    globalState.__tkPageContextBridgeInstalled = false;
  };
}

function fields(value: unknown): Record<string, unknown> {
  const module = object(value);
  const wrappedFields = object(module.fields);
  return Object.keys(wrappedFields).length > 0 ? wrappedFields : module;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function scalar(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function decimal(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim().replace(/,/gu, "");
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(normalized) ? normalized : null;
}

function decimalToMinor(value: unknown): string | null {
  const normalized = decimal(value);
  if (!normalized) return null;
  const [whole = "0", fraction = ""] = normalized.split(".");
  return (BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2))).toString();
}

function readSourcePrice(
  mainPrice: Record<string, unknown>,
  rootData: Record<string, unknown>
): {
  sourcePriceWire: { amountMinor: string; currency: "CNY" };
  sourcePriceRangeWire: {
    minAmountMinor: string;
    maxAmountMinor: string;
    currency: "CNY";
  };
} | null {
  const trade = object(object(mainPrice.finalPriceModel).tradeWithoutPromotion);
  const orderParam = object(object(rootData.orderParamModel).orderParam);
  const skuParam = object(orderParam.skuParam);
  const rangePrices = Array.isArray(skuParam.skuRangePrices) ? skuParam.skuRangePrices : [];
  const currentPrices = Array.isArray(object(mainPrice.priceModel).currentPrices)
    ? object(mainPrice.priceModel).currentPrices as unknown[]
    : [];
  const candidates = [
    trade.offerMinPrice,
    trade.offerMaxPrice,
    ...rangePrices.map((entry) => object(entry).price),
    ...currentPrices.map((entry) => object(entry).price)
  ].flatMap((value) => {
    const minor = decimalToMinor(value);
    return minor === null ? [] : [minor];
  });
  if (candidates.length === 0) return null;
  const amounts = candidates.map(BigInt);
  const minAmountMinor = amounts.reduce((left, right) => left < right ? left : right).toString();
  const maxAmountMinor = amounts.reduce((left, right) => left > right ? left : right).toString();
  return {
    sourcePriceWire: { amountMinor: minAmountMinor, currency: "CNY" },
    sourcePriceRangeWire: { minAmountMinor, maxAmountMinor, currency: "CNY" }
  };
}

function readSkus(rootData: Record<string, unknown>): {
  skuAttributes: SnapshotSkuAttributes;
  skus: SnapshotSkus;
  expectedSkuCount: number | null;
  fieldEvidence: "captured" | "source_absent" | "capture_failed" | null;
} {
  const skuModel = object(rootData.skuModel);
  const rawProps = Array.isArray(skuModel.skuProps) ? skuModel.skuProps : [];
  const skuAttributes = rawProps.flatMap((rawProp) => {
    const prop = object(rawProp);
    const name = text(prop.prop);
    const rawValues = Array.isArray(prop.value) ? prop.value : [];
    const values = rawValues.flatMap((rawValue) => {
      const value = object(rawValue);
      const valueName = text(value.name);
      if (!valueName) return [];
      const imageUrl = normalizeImageUrl(text(value.imageUrl))[0];
      return [{ name: valueName, ...(imageUrl ? { imageUrl } : {}) }];
    });
    return name && values.length > 0 ? [{ name, values }] : [];
  });
  const imageByValue = new Map<string, string>();
  for (const attribute of skuAttributes) {
    for (const value of attribute.values) {
      if (value.imageUrl) imageByValue.set(value.name, value.imageUrl);
    }
  }
  const skuInfoMap = object(skuModel.skuInfoMap);
  const entries = Object.entries(skuInfoMap);
  const expectedSkuCount = entries.length > 0 ? entries.length : null;
  if (rootData.isSkuOffer !== true && entries.length === 0) {
    return { skuAttributes, skus: [], expectedSkuCount: null, fieldEvidence: "source_absent" };
  }
  const skus = entries.flatMap(([key, rawSku]) => {
    const sku = object(rawSku);
    const parts = decodeSkuText(text(sku.specAttrs) || key)
      .split(">")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length !== skuAttributes.length || parts.length === 0) return [];
    const attributes = Object.fromEntries(
      skuAttributes.map((attribute, index) => [attribute.name, parts[index] ?? ""])
    );
    if (Object.values(attributes).some((value) => !value)) return [];
    const priceMinor = decimalToMinor(sku.discountPrice ?? sku.price);
    const skuId = scalar(sku.skuId)
      ?? text(sku.specId)
      ?? deterministicSkuId(attributes);
    const imageUrl = parts.flatMap((part) => {
      const image = imageByValue.get(part);
      return image ? [image] : [];
    })[0] ?? null;
    return [{
      skuId,
      attributes,
      priceWire: priceMinor ? { amountMinor: priceMinor, currency: "CNY" as const } : null,
      stock: integer(sku.canBookCount),
      imageUrl
    }];
  });
  return {
    skuAttributes,
    skus,
    expectedSkuCount,
    fieldEvidence: entries.length > 0 && skus.length === entries.length
      ? "captured"
      : "capture_failed"
  };
}

function decodeSkuText(value: string): string {
  return value
    .replace(/&gt;/giu, ">")
    .replace(/&#62;/gu, ">")
    .replace(/&amp;/giu, "&");
}

function deterministicSkuId(attributes: Record<string, string>): string {
  const source = Object.entries(attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("|");
  let hash = 2166136261;
  for (const character of source) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `attrs_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function readPackageFacts(productPackInfo: Record<string, unknown>, skus: SnapshotSkus): {
  weightKg: string | null;
  dimensionsCm: PageContextSnapshot["dimensionsCm"];
  weightEvidence: "captured" | "source_absent" | "capture_failed";
  dimensionsEvidence: "captured" | "source_absent" | "capture_failed";
  skus: SnapshotSkus;
} {
  const scale = object(productPackInfo.pieceWeightScale);
  const rows = Array.isArray(scale.pieceWeightScaleInfo)
    ? scale.pieceWeightScaleInfo.map(object)
    : [];
  if (rows.length === 0) {
    return {
      weightKg: null,
      dimensionsCm: null,
      weightEvidence: "source_absent",
      dimensionsEvidence: "source_absent",
      skus
    };
  }
  const commonWeight = commonPositiveFact(rows.map((row) => row.weight));
  const weightBySkuId = new Map(
    rows.flatMap((row) => {
      const skuId = scalar(row.skuId);
      const weightText = decimal(row.weight);
      const weight = weightText === null ? null : Number(weightText);
      return skuId && weight !== null && weight > 0
        ? [[skuId, formatDecimal(weight / 1000)] as const]
        : [];
    })
  );
  const dimensionsBySkuId = new Map(
    rows.flatMap((row) => {
      const skuId = scalar(row.skuId);
      const length = positiveDecimal(row.length);
      const width = positiveDecimal(row.width);
      const height = positiveDecimal(row.height);
      return skuId && length !== null && width !== null && height !== null
        ? [[skuId, {
            lengthCm: formatDecimal(length),
            widthCm: formatDecimal(width),
            heightCm: formatDecimal(height)
          }] as const]
        : [];
    })
  );
  const skusWithPackageFacts = skus.map((sku) => {
    const weightKg = weightBySkuId.get(sku.skuId);
    const dimensionsCm = dimensionsBySkuId.get(sku.skuId);
    return {
      ...sku,
      ...(weightKg ? { weightKg } : {}),
      ...(dimensionsCm ? { dimensionsCm } : {})
    };
  });
  const hasSkuAddressableRows = weightBySkuId.size > 0 && skus.length > 0;
  const weightEvidence = hasSkuAddressableRows
    ? skusWithPackageFacts.every((sku) => typeof sku.weightKg === "string")
      ? "captured"
      : "capture_failed"
    : commonWeight.evidence;
  const commonLength = commonPositiveFact(rows.map((row) => row.length));
  const commonWidth = commonPositiveFact(rows.map((row) => row.width));
  const commonHeight = commonPositiveFact(rows.map((row) => row.height));
  const hasSkuAddressableDimensions = dimensionsBySkuId.size > 0 && skus.length > 0;
  const dimensionsEvidence = hasSkuAddressableDimensions
    ? skusWithPackageFacts.every((sku) => sku.dimensionsCm !== undefined)
      ? "captured"
      : "capture_failed"
    : [commonLength, commonWidth, commonHeight].every((fact) => fact.evidence === "captured")
        ? "captured"
        : [commonLength, commonWidth, commonHeight].every((fact) => fact.evidence === "source_absent")
          ? "source_absent"
          : "capture_failed";
  const hasCommonDimensions =
    [commonLength, commonWidth, commonHeight].every((fact) => fact.evidence === "captured");
  return {
    weightKg: commonWeight.value === null ? null : formatDecimal(commonWeight.value / 1000),
    dimensionsCm: hasCommonDimensions
      ? {
          lengthCm: formatDecimal(commonLength.value!),
          widthCm: formatDecimal(commonWidth.value!),
          heightCm: formatDecimal(commonHeight.value!)
        }
      : null,
    weightEvidence,
    dimensionsEvidence,
    skus: skusWithPackageFacts
  };
}

function positiveDecimal(value: unknown): number | null {
  const parsed = decimal(value);
  if (parsed === null) return null;
  const number = Number(parsed);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function commonPositiveFact(values: unknown[]): {
  value: number | null;
  evidence: "captured" | "source_absent" | "capture_failed";
} {
  const numbers = values.map((value) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
  );
  if (numbers.every((value) => value === null)) {
    return { value: null, evidence: "source_absent" };
  }
  const first = numbers[0] ?? null;
  if (first === null || numbers.some((value) => value === null || value !== first)) {
    return { value: null, evidence: "capture_failed" };
  }
  return { value: first, evidence: "captured" };
}

function formatDecimal(value: number): string {
  return String(Number(value.toFixed(6)));
}

function optionValues(
  attributes: SnapshotSkuAttributes,
  namePattern: RegExp
): string[] {
  return attributes
    .filter((attribute) => namePattern.test(attribute.name))
    .flatMap((attribute) => attribute.values.map((value) => value.name));
}

function normalizeGalleryImage(value: unknown): string[] {
  if (typeof value === "string") return normalizeImageUrl(value);
  const image = object(value);
  const raw = text(image.fullPathImageURI)
    || text(image.size310x310ImageURI)
    || text(image.imageURI);
  return normalizeImageUrl(raw);
}

function normalizeImageUrl(raw: string): string[] {
  if (!raw) return [];
  if (raw.startsWith("//")) return [`https:${raw}`];
  if (/^https?:\/\//iu.test(raw)) return [raw];
  return [`https://cbu01.alicdn.com/${raw.replace(/^\/+/u, "")}`];
}

function findAttributes(root: unknown): Array<{ name: string; value: string }> {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const visited = new WeakSet<object>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > 12 || !current.value || typeof current.value !== "object") {
      continue;
    }
    if (visited.has(current.value)) continue;
    visited.add(current.value);
    if (Array.isArray(current.value)) {
      const parsed = parseAttributeArray(current.value);
      if (parsed.length > 0) return parsed;
      current.value.forEach((value) => queue.push({ value, depth: current.depth + 1 }));
      continue;
    }
    const record = current.value as Record<string, unknown>;
    for (const key of ["featureAttributes", "productAttributes", "attributes"]) {
      if (Array.isArray(record[key])) queue.unshift({ value: record[key], depth: current.depth + 1 });
    }
    Object.values(record).forEach((value) =>
      queue.push({ value, depth: current.depth + 1 })
    );
  }
  return [];
}

function parseAttributeArray(value: unknown[]): Array<{ name: string; value: string }> {
  return value.flatMap((entry) => {
    const attribute = object(entry);
    const name = text(attribute.name);
    const attributeValue = text(attribute.value)
      || (Array.isArray(attribute.values)
        ? attribute.values.map((item) => text(item)).filter(Boolean).join(",")
        : "");
    return name && attributeValue ? [{ name, value: attributeValue }] : [];
  });
}

if (typeof window !== "undefined") installPageContextBridge(window);
