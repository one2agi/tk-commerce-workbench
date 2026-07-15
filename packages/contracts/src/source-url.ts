export interface Normalized1688Url {
  readonly sourceItemId: string;
  readonly canonicalUrl: string;
}

const OFFER_PATH = /^\/offer\/(\d+)\.html$/;

export function normalize1688OfferUrl(input: string): Normalized1688Url {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("invalid 1688 product URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("1688 product URL must use HTTP(S)");
  }
  if (url.hostname.toLowerCase() !== "detail.1688.com") {
    throw new Error("1688 product URL must use detail.1688.com");
  }
  const match = OFFER_PATH.exec(url.pathname);
  const sourceItemId = match?.[1];
  if (!sourceItemId) throw new Error("1688 product URL is missing its offer id");
  return Object.freeze({
    sourceItemId,
    canonicalUrl: `https://detail.1688.com/offer/${sourceItemId}.html`
  });
}
