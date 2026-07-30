import type { IngestLocalCaptureItemV3 } from "@tk/contracts/commands";

export type LocalDetailCapture = Omit<IngestLocalCaptureItemV3, "idempotencyKey">;

export type PageContextSnapshot = Readonly<{
  offerId: string | null;
  title: string;
  supplierName: string | null;
  mainImages: string[];
  attributes: Array<{ name: string; value: string }>;
  itemNumber?: string | null;
  category?: string | null;
  sourcePriceWire?: LocalDetailCapture["sourcePriceWire"];
  sourcePriceRangeWire?: LocalDetailCapture["sourcePriceRangeWire"];
  sourceStock?: number | null;
  weightKg?: string | null;
  dimensionsCm?: LocalDetailCapture["dimensionsCm"];
  saleAttributes?: LocalDetailCapture["saleAttributes"];
  skuAttributes?: LocalDetailCapture["skuAttributes"];
  colors?: string[];
  sizes?: string[];
  skus?: LocalDetailCapture["skus"];
  expectedSkuCount?: number | null;
  fieldEvidence?: Pick<
    LocalDetailCapture["diagnostics"]["fieldEvidence"],
    "price" | "stock" | "skus" | "weight" | "dimensions"
  >;
}>;

type TitleSource = LocalDetailCapture["diagnostics"]["titleSource"];

const PRODUCT_TITLE_SELECTORS = [
  "[data-tk-product-title]",
  "[data-testid='product-title']",
  "[data-module-name='productTitle'] h1",
  ".od-title",
  ".title-text"
] as const;

const MAIN_GALLERY_SELECTORS = [
  "[data-tk-main-gallery]",
  "[data-testid='main-gallery']",
  "[data-role='main-gallery']",
  ".od-gallery",
  ".od-gallery-preview",
  ".od-picture-gallery-section",
  ".detail-gallery"
] as const;

const DETAIL_ROOT_SELECTORS = [
  "[data-tk-detail]",
  "#desc-lazyload-container",
  "#detailContent",
  ".detail-content",
  ".offer-detail-content"
] as const;

const ATTRIBUTE_ROOT_SELECTORS = [
  "[data-tk-attributes]",
  "[data-testid='product-attributes']",
  ".core-attributes",
  ".product-attribute",
  ".offer-attributes"
] as const;

const SKU_ROOT_SELECTORS = [
  "[data-tk-sku]",
  "[data-testid='sku-selector']",
  ".sku-wrapper",
  ".sku-module",
  ".module-od-sku-selection",
  ".od-sku"
] as const;

const PRICE_ROOT_SELECTORS = [
  "[data-module-name='mainPrice']",
  ".module-od-main-price",
  ".price-component",
  "[class*='main-price']"
] as const;

const UI_IMAGE_PATTERN =
  /(?:^|[-_/])(?:sprite|icon|logo|avatar|placeholder)(?:[-_.\\/]|$)|-\d+-tps-\d+-\d+\.svg$|(?:^|\/)\d{1,3}-\d{1,3}\.(?:png|gif)$/iu;

export function parse1688DetailPage(
  document: Document,
  rawUrl: string = document.location?.href ?? "",
  capturedAt = new Date(),
  pageContext: PageContextSnapshot | null = null
): LocalDetailCapture {
  const sourceItemId = extractSourceItemId(rawUrl);
  if (!sourceItemId) throw new Error("detail_source_item_id_missing");
  if (pageContext?.offerId && pageContext.offerId !== sourceItemId) {
    throw new Error("detail_source_item_mismatch");
  }

  const sourceUrl = `https://detail.1688.com/offer/${sourceItemId}.html`;
  const jsonLd = readProductJsonLd(document);
  const titleSelection = selectTitle(document, pageContext, jsonLd);
  if (!titleSelection.title) throw new Error("detail_title_missing");
  if (isBlockedPageTitle(titleSelection.title)) throw new Error("detail_page_invalid");
  if (
    pageContext?.supplierName
    && normalizeComparable(titleSelection.title) === normalizeComparable(pageContext.supplierName)
  ) {
    throw new Error("detail_title_is_supplier");
  }

  const domMainCandidates = scopedImageCandidates(
    document,
    MAIN_GALLERY_SELECTORS,
    { minWidth: 300, minHeight: 300 }
  );
  const rawMainImages = pageContext?.mainImages.length
    ? pageContext.mainImages
    : jsonLd.images.length
      ? jsonLd.images
      : domMainCandidates.accepted;
  const mainResult = validatedUrls(rawMainImages);
  if (mainResult.accepted.length === 0) throw new Error("detail_main_images_missing");

  const detailRoot = firstRoot(document, DETAIL_ROOT_SELECTORS);
  const detailCandidates = detailRoot
    ? imageCandidatesWithin(detailRoot, { minWidth: 300, minHeight: 1 })
    : { accepted: [], rejected: 0 };
  const detailResult = validatedUrls(detailCandidates.accepted)
    .accepted
    .filter((url) => !mainResult.accepted.includes(url));
  const descriptionText = detailRoot
    ? cleanDescription(detailRoot.textContent)
    : cleanText(jsonLd.description);

  const attributeRoot = firstRoot(document, ATTRIBUTE_ROOT_SELECTORS);
  const attributes = uniqueAttributes(
    [
      ...(pageContext?.attributes ?? []),
      ...jsonLd.attributes,
      ...(attributeRoot ? extractAttributes(attributeRoot) : [])
    ]
  );

  const skuRoot = firstRoot(document, SKU_ROOT_SELECTORS);
  const priceRoot = firstRoot(document, PRICE_ROOT_SELECTORS);
  const stockEvidencePresent = Boolean(
    document.querySelector(".item-price-stock, [class*='stock']")
    && /库存|可售|stock/iu.test(document.body?.textContent ?? "")
  );
  const domSkuAttributes = skuRoot ? extractSkuAttributes(skuRoot) : [];
  const skuAttributes = pageContext?.skuAttributes?.length
    ? pageContext.skuAttributes
    : domSkuAttributes;
  const skuText = skuAttributes.map(
    (attribute) => `${attribute.name}: ${attribute.values.map((value) => value.name).join(" / ")}`
  );
  const skus = pageContext?.skus ?? [];
  const expectedSkuCount = pageContext?.expectedSkuCount ?? null;
  const contextEvidence = pageContext?.fieldEvidence;
  const fieldEvidence: LocalDetailCapture["diagnostics"]["fieldEvidence"] = {
    title: "captured",
    mainImages: "captured",
    detail: detailRoot || descriptionText
      ? detailResult.length > 0 || Boolean(descriptionText)
        ? "captured"
        : "capture_failed"
      : "source_absent",
    attributes: attributes.length > 0
      ? "captured"
      : attributeRoot
        ? "capture_failed"
        : "source_absent",
    price: contextEvidence?.price ?? (priceRoot ? "capture_failed" : "source_absent"),
    stock: contextEvidence?.stock ?? (stockEvidencePresent ? "capture_failed" : "source_absent"),
    skus: contextEvidence?.skus
      ?? (skuRoot ? "capture_failed" : "source_absent"),
    weight: contextEvidence?.weight ?? "source_absent",
    dimensions: contextEvidence?.dimensions ?? "source_absent"
  };
  const expectedSkuMismatch = expectedSkuCount !== null && expectedSkuCount !== skus.length;
  const warnings = captureWarnings(fieldEvidence, expectedSkuMismatch);
  const captureQuality: LocalDetailCapture["captureQuality"] =
    Object.values(fieldEvidence).includes("capture_failed") || expectedSkuMismatch
      ? "detail_page_partial"
      : "detail_page_complete";

  return {
    sourceItemId,
    sourceUrl,
    title: titleSelection.title,
    mainImages: mainResult.accepted,
    detailImages: detailResult,
    ...(descriptionText ? { descriptionText } : {}),
    itemNumber: pageContext?.itemNumber
      ?? attributeValue(attributes, /^(?:货号|商品货号|款号)$/u),
    category: pageContext?.category ?? null,
    sourcePriceWire: pageContext?.sourcePriceWire ?? null,
    sourcePriceRangeWire: pageContext?.sourcePriceRangeWire ?? null,
    sourceStock: pageContext?.sourceStock ?? null,
    weightKg: pageContext?.weightKg ?? null,
    dimensionsCm: pageContext?.dimensionsCm ?? null,
    attributes,
    saleAttributes: pageContext?.saleAttributes ?? [],
    skuAttributes,
    skuText,
    colors: pageContext?.colors ?? optionNames(skuAttributes, /颜色|顏色|color/iu),
    sizes: pageContext?.sizes ?? optionNames(skuAttributes, /尺码|尺寸|規格|size/iu),
    skus,
    capturedAt: capturedAt.toISOString(),
    captureQuality,
    diagnostics: {
      version: 2,
      pageKind: "offer_detail",
      titleSource: titleSelection.source,
      stableForMs: 2000,
      fieldEvidence,
      expectedSkuCount,
      capturedSkuCount: skus.length,
      acceptedMainImages: mainResult.accepted.length,
      acceptedDetailImages: detailResult.length,
      rejectedImages:
        mainResult.rejected
        + domMainCandidates.rejected
        + detailCandidates.rejected
        + (detailCandidates.accepted.length - detailResult.length),
      warnings
    }
  };
}

export async function captureStable1688DetailPage(options: {
  document: Document;
  sourceUrl?: string;
  timeoutMs?: number;
  stableForMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  readPageContext?: () => Promise<PageContextSnapshot | null>;
  onStage?: (stage: "waiting_product" | "loading_detail" | "validating") => void;
}): Promise<LocalDetailCapture> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const stableForMs = options.stableForMs ?? 2_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const now = options.now ?? (() => Date.now());
  const delay = options.delay ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const sourceUrl = options.sourceUrl ?? options.document.location?.href ?? "";
  const readPageContext = options.readPageContext
    ?? (() => requestPageContext(options.document.defaultView));
  const customDelay = options.delay;
  options.onStage?.("loading_detail");
  await prepareLazyContent(options.document, delay);
  const startedAt = now();
  let stableSince = startedAt;
  let lastFingerprint = "";
  let lastError: Error | null = null;

  while (now() - startedAt <= timeoutMs) {
    options.onStage?.("waiting_product");
    try {
      const pageContext = await readPageContext();
      const capture = parse1688DetailPage(options.document, sourceUrl, new Date(), pageContext);
      const fingerprint = captureFingerprint(capture);
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        stableSince = now();
      } else if (now() - stableSince >= stableForMs) {
        options.onStage?.("validating");
        return {
          ...capture,
          diagnostics: {
            ...capture.diagnostics,
            stableForMs: now() - stableSince
          }
        };
      }
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("detail_capture_failed");
      lastFingerprint = "";
      stableSince = now();
    }
    if (customDelay) {
      await delay(pollIntervalMs);
    } else {
      await waitForRelevantMutation(options.document, pollIntervalMs);
    }
  }
  throw lastError ?? new Error("detail_page_timeout");
}

export function createDetailCaptureMessageHandler(
  document: Document,
  sourceUrl: string = document.location?.href ?? "",
  options: {
    capture?: () => Promise<LocalDetailCapture>;
    onStage?: (stage: "waiting_product" | "loading_detail" | "validating") => void;
  } = {}
) {
  return (
    message: unknown,
    sendResponse: (response: unknown) => void
  ): boolean => {
    if (!message || typeof message !== "object"
      || (message as { kind?: unknown }).kind !== "capture-detail") {
      return false;
    }
    const capture = options.capture ?? (() => captureStable1688DetailPage({
      document,
      sourceUrl,
      onStage: options.onStage
    }));
    void capture()
      .then((result) => sendResponse({ ok: true, capture: result }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "detail_capture_failed"
      }));
    return true;
  };
}

function extractSourceItemId(rawUrl: string): string | null {
  return /detail\.1688\.com\/offer\/(\d+)\.html/i.exec(rawUrl)?.[1]
    ?? /\/offer\/(\d+)\.html/i.exec(rawUrl)?.[1]
    ?? null;
}

function selectTitle(
  document: Document,
  pageContext: PageContextSnapshot | null,
  jsonLd: ProductJsonLd
): { title: string; source: TitleSource } {
  const contextTitle = cleanText(pageContext?.title);
  if (contextTitle) return { title: contextTitle, source: "page_context" };
  if (jsonLd.title) return { title: jsonLd.title, source: "json_ld" };
  for (const selector of PRODUCT_TITLE_SELECTORS) {
    const title = cleanText(document.querySelector(selector)?.textContent);
    if (title) return { title, source: "product_heading" };
  }
  const metaTitle = readProductMetaTitle(document);
  if (metaTitle) return { title: metaTitle, source: "product_heading" };
  if (hasProductEvidence(document)) {
    const documentTitle = normalizeProductTitle(document.title);
    if (documentTitle) return { title: documentTitle, source: "document_title" };
    const heading = Array.from(document.querySelectorAll("h1"))
      .map((element) => normalizeProductTitle(element.textContent ?? ""))
      .find((value) => value.length >= 8
        && !/(?:有限公司|有限责任公司|旗舰店|官方店)\s*$/u.test(value));
    if (heading) return { title: heading, source: "product_heading" };
  }
  return { title: "", source: "product_heading" };
}

function hasProductEvidence(document: Document): boolean {
  return Boolean(
    firstRoot(document, MAIN_GALLERY_SELECTORS)
    || document.querySelector("[data-tk-product-hero], [class*='price'], [data-module-name='mainPrice']")
  );
}

function captureWarnings(
  evidence: LocalDetailCapture["diagnostics"]["fieldEvidence"],
  expectedSkuMismatch: boolean
): string[] {
  const warningByField: Partial<Record<keyof typeof evidence, string>> = {
    detail: "detail_capture_incomplete",
    attributes: "missing_attributes",
    price: "missing_source_price",
    stock: "missing_source_stock",
    skus: "missing_sku",
    weight: "missing_weight",
    dimensions: "missing_dimensions"
  };
  const warnings = Object.entries(evidence).flatMap(([field, state]) => {
    const warning = warningByField[field as keyof typeof evidence];
    return state === "capture_failed" && warning ? [warning] : [];
  });
  if (expectedSkuMismatch && !warnings.includes("missing_sku")) warnings.push("missing_sku");
  return warnings;
}

function optionNames(
  attributes: LocalDetailCapture["skuAttributes"],
  namePattern: RegExp
): string[] {
  return attributes
    .filter((attribute) => namePattern.test(attribute.name))
    .flatMap((attribute) => attribute.values.map((value) => value.name));
}

function readProductMetaTitle(document: Document): string {
  for (const selector of [
    "meta[property='og:title']",
    "meta[name='og:title']",
    "meta[name='twitter:title']",
    "meta[name='title']"
  ]) {
    const title = normalizeProductTitle(
      document.querySelector<HTMLMetaElement>(selector)?.content
    );
    if (title) return title;
  }
  return "";
}

function normalizeProductTitle(value: string | null | undefined): string {
  const normalized = cleanText(value)
    .replace(/\s*[-_｜|]\s*(?:阿里巴巴|1688|全球领先的采购批发平台|批发网).*$/u, "")
    .replace(/\s*-\s*阿里巴巴\s*$/u, "")
    .slice(0, 240);
  return /^(?:1688|阿里巴巴|商品详情)$/u.test(normalized) || isBlockedPageTitle(normalized)
    ? ""
    : normalized;
}

function isBlockedPageTitle(value: string): boolean {
  return /(?:登录页面|全球领先的采购批发平台|使用\s*1688\s*\/\s*淘宝App\s*扫码登录|验证码|密码登录|短信登录|免费注册)/u
    .test(cleanText(value));
}

type ProductJsonLd = {
  title: string;
  description: string;
  images: string[];
  attributes: Array<{ name: string; value: string }>;
};

function readProductJsonLd(document: Document): ProductJsonLd {
  for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent ?? "") as unknown;
      const candidates = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { "@graph"?: unknown })["@graph"])
          ? (parsed as { "@graph": unknown[] })["@graph"]
          : [parsed];
      const product = candidates.find((candidate) => {
        if (!candidate || typeof candidate !== "object") return false;
        const type = (candidate as { "@type"?: unknown })["@type"];
        return type === "Product" || (Array.isArray(type) && type.includes("Product"));
      }) as Record<string, unknown> | undefined;
      if (!product) continue;
      const image = product.image;
      const images = Array.isArray(image)
        ? image.filter((value): value is string => typeof value === "string")
        : typeof image === "string"
          ? [image]
          : [];
      const attributes = Array.isArray(product.additionalProperty)
        ? product.additionalProperty.flatMap((value) => {
            if (!value || typeof value !== "object") return [];
            const item = value as { name?: unknown; value?: unknown };
            const name = cleanText(typeof item.name === "string" ? item.name : "");
            const attributeValue = cleanText(
              typeof item.value === "string" || typeof item.value === "number"
                ? String(item.value)
                : ""
            );
            return name && attributeValue ? [{ name, value: attributeValue }] : [];
          })
        : [];
      return {
        title: cleanText(typeof product.name === "string" ? product.name : ""),
        description: cleanText(typeof product.description === "string" ? product.description : ""),
        images,
        attributes
      };
    } catch {
      // Invalid third-party JSON-LD must not abort the validated DOM fallback.
    }
  }
  return { title: "", description: "", images: [], attributes: [] };
}

function firstRoot(document: Document, selectors: ReadonlyArray<string>): Element | null {
  for (const selector of selectors) {
    const root = document.querySelector(selector);
    if (root) return root;
  }
  return null;
}

function scopedImageCandidates(
  document: Document,
  selectors: ReadonlyArray<string>,
  dimensions: { minWidth: number; minHeight: number }
): { accepted: string[]; rejected: number } {
  const roots = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
  const accepted: string[] = [];
  let rejected = 0;
  for (const root of roots) {
    const result = imageCandidatesWithin(root, dimensions);
    accepted.push(...result.accepted);
    rejected += result.rejected;
  }
  return { accepted: [...new Set(accepted)], rejected };
}

function imageCandidatesWithin(
  root: Element,
  dimensions: { minWidth: number; minHeight: number }
): { accepted: string[]; rejected: number } {
  const accepted: string[] = [];
  let rejected = 0;
  for (const image of root.querySelectorAll<HTMLImageElement>("img")) {
    const raw = image.currentSrc
      || image.getAttribute("src")
      || image.getAttribute("data-src")
      || image.getAttribute("data-lazy-src")
      || image.getAttribute("data-original");
    const width = image.naturalWidth || image.width || Number(image.getAttribute("width") ?? 0);
    const height = image.naturalHeight || image.height || Number(image.getAttribute("height") ?? 0);
    if (!raw || width < dimensions.minWidth || height < dimensions.minHeight) {
      rejected += 1;
      continue;
    }
    accepted.push(raw);
  }
  return { accepted, rejected };
}

function validatedUrls(values: ReadonlyArray<string | null | undefined>): {
  accepted: string[];
  rejected: number;
} {
  const accepted: string[] = [];
  let rejected = 0;
  for (const value of values) {
    const raw = value?.trim();
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) {
      rejected += 1;
      continue;
    }
    try {
      const normalized = raw.startsWith("//") ? `https:${raw}` : raw;
      const url = new URL(normalized);
      const pathname = decodeURIComponent(url.pathname).toLowerCase();
      if (
        !["http:", "https:"].includes(url.protocol)
        || pathname.endsWith(".svg")
        || UI_IMAGE_PATTERN.test(pathname)
      ) {
        rejected += 1;
        continue;
      }
      accepted.push(url.toString());
    } catch {
      rejected += 1;
    }
  }
  return { accepted: [...new Set(accepted)], rejected };
}

function extractAttributes(root: Element): Array<{ name: string; value: string }> {
  const values = new Map<string, string>();
  root.querySelectorAll("dl").forEach((row) => {
    addAttribute(values, row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent);
  });
  root.querySelectorAll("[data-tk-attribute], .attr-item, li").forEach((row) => {
    const cells = Array.from(row.querySelectorAll(":scope > span, :scope > div"))
      .map((cell) => cleanText(cell.textContent))
      .filter(Boolean);
    if (cells.length >= 2) addAttribute(values, cells[0], cells.slice(1).join(" "));
  });
  root.querySelectorAll("tr").forEach((row) => {
    const cells = Array.from(row.querySelectorAll(":scope > th, :scope > td"))
      .map((cell) => cleanText(cell.textContent))
      .filter(Boolean);
    for (let index = 0; index + 1 < cells.length; index += 2) {
      addAttribute(values, cells[index], cells[index + 1]);
    }
  });
  return Array.from(values, ([name, value]) => ({ name, value }));
}

function attributeValue(
  attributes: ReadonlyArray<{ name: string; value: string }>,
  namePattern: RegExp
): string | null {
  return attributes.find((attribute) => namePattern.test(attribute.name))?.value ?? null;
}

function uniqueAttributes(
  attributes: ReadonlyArray<{ name: string; value: string }>
): Array<{ name: string; value: string }> {
  const values = new Map<string, string>();
  for (const attribute of attributes) addAttribute(values, attribute.name, attribute.value);
  return Array.from(values, ([name, value]) => ({ name, value }));
}

function addAttribute(
  values: Map<string, string>,
  rawName: string | null | undefined,
  rawValue: string | null | undefined
): void {
  const name = cleanText(rawName).replace(/[：:]\s*$/u, "");
  const value = cleanText(rawValue);
  if (!name || !value || name === value) return;
  values.set(name.slice(0, 100), value.slice(0, 500));
}

function extractSkuAttributes(root: Element): NonNullable<LocalDetailCapture["skuAttributes"]> {
  const groups = Array.from(root.querySelectorAll(
    "[data-tk-sku-group], [data-role='sku-group'], .sku-prop, .feature-item"
  ));
  return groups.flatMap((group) => {
    const name = cleanText(
      group.querySelector(
        "[data-tk-sku-name], [data-role='sku-name'], strong, h3, .feature-item-label, .prop-name, .sku-title"
      )
        ?.textContent
    ).replace(/[：:]\s*$/u, "");
    const values = Array.from(group.querySelectorAll<HTMLElement>(
      "[data-tk-sku-value], [data-role='option'], [role='option'], button, .value-item"
      + ", .sku-filter-button, .label-name"
    )).flatMap((element) => {
      const valueName = cleanText(element.getAttribute("title") ?? element.textContent);
      if (!valueName || valueName === name) return [];
      const image = element.matches("img")
        ? element as HTMLImageElement
        : element.querySelector<HTMLImageElement>("img");
      const imageUrl = validatedUrls([
        image?.currentSrc || image?.getAttribute("src") || image?.getAttribute("data-src")
      ]).accepted[0];
      return [{ name: valueName.slice(0, 200), ...(imageUrl ? { imageUrl } : {}) }];
    });
    const uniqueValues = [...new Map(values.map((value) => [value.name, value])).values()];
    return name && uniqueValues.length > 0 ? [{ name: name.slice(0, 100), values: uniqueValues }] : [];
  });
}

function cleanDescription(value: string | null | undefined): string {
  return cleanText(value).slice(0, 20_000);
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

function normalizeComparable(value: string): string {
  return cleanText(value).replace(/[，,。.!！?？·\s]/gu, "").toLowerCase();
}

function captureFingerprint(capture: LocalDetailCapture): string {
  return JSON.stringify({
    title: capture.title,
    mainImages: capture.mainImages,
    detailImages: capture.detailImages,
    attributes: capture.attributes,
    skuAttributes: capture.skuAttributes,
    sourcePriceWire: capture.sourcePriceWire,
    sourcePriceRangeWire: capture.sourcePriceRangeWire,
    sourceStock: capture.sourceStock,
    skus: capture.skus
  });
}

async function prepareLazyContent(
  document: Document,
  delay: (milliseconds: number) => Promise<void>
): Promise<void> {
  if (document.defaultView?.navigator.userAgent.toLowerCase().includes("jsdom")) return;
  const windowValue = document.defaultView;
  const documentHeight = Math.max(
    document.documentElement?.scrollHeight ?? 0,
    document.body?.scrollHeight ?? 0
  );
  if (windowValue && documentHeight > 0) {
    for (const ratio of [0.35, 0.65, 0.9]) {
      try {
        windowValue.scrollTo({ top: Math.round(documentHeight * ratio), behavior: "auto" });
      } catch {
        // Some 1688 embedded views do not expose scrollTo.
      }
      await delay(200);
    }
  }
  for (const selector of [...SKU_ROOT_SELECTORS, ...ATTRIBUTE_ROOT_SELECTORS, ...DETAIL_ROOT_SELECTORS]) {
    const root = document.querySelector<HTMLElement>(selector);
    try {
      root?.scrollIntoView({ block: "center" });
    } catch {
      // Best effort: the observer/poll loop still handles already-loaded pages.
    }
  }
}

async function waitForRelevantMutation(document: Document, timeoutMs: number): Promise<void> {
  const windowValue = document.defaultView;
  const Observer = windowValue?.MutationObserver;
  const root = document.querySelector("main")
    ?? firstRoot(document, [...MAIN_GALLERY_SELECTORS, ...DETAIL_ROOT_SELECTORS])
    ?? document.body;
  if (!Observer || !root) {
    await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    return;
  }
  await new Promise<void>((resolve) => {
    const observer = new Observer(() => finish());
    const timer = windowValue.setTimeout(() => finish(), timeoutMs);
    const finish = () => {
      windowValue.clearTimeout(timer);
      observer.disconnect();
      resolve();
    };
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    });
  });
}

export async function requestPageContext(
  windowValue: Window | null,
  timeoutMs = 1_000
): Promise<PageContextSnapshot | null> {
  if (!windowValue) return null;
  const requestId = `tk-context-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const mailbox = windowValue.document.createElement("span");
    mailbox.hidden = true;
    mailbox.setAttribute("data-tk-context-request-id", requestId);
    const cleanup = () => {
      windowValue.clearTimeout(timeout);
      mailbox.removeEventListener("tk-product-context-response", listener);
      mailbox.remove();
    };
    const timeout = windowValue.setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const listener = () => {
      let snapshot: unknown = null;
      try {
        snapshot = JSON.parse(mailbox.textContent ?? "null");
      } catch {
        snapshot = null;
      }
      cleanup();
      resolve(isPageContextSnapshot(snapshot) ? snapshot : null);
    };
    mailbox.addEventListener("tk-product-context-response", listener);
    windowValue.document.documentElement.append(mailbox);
    const requestEvent = windowValue.document.createEvent("Event");
    requestEvent.initEvent("tk-product-context-request", true, false);
    mailbox.dispatchEvent(requestEvent);
  });
}

function isPageContextSnapshot(value: unknown): value is PageContextSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<PageContextSnapshot>;
  return (snapshot.offerId === null || typeof snapshot.offerId === "string")
    && typeof snapshot.title === "string"
    && (snapshot.supplierName === null || typeof snapshot.supplierName === "string")
    && Array.isArray(snapshot.mainImages)
    && snapshot.mainImages.every((url) => typeof url === "string")
    && Array.isArray(snapshot.attributes);
}
