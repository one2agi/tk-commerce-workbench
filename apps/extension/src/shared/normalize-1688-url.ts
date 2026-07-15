// Canonicalises a 1688 detail URL: extracts the offer id, strips tracking
// parameters, and rejects non-detail.1688.com hosts.

export interface Normalized1688Url {
  readonly sourceItemId: string;
  readonly canonicalUrl: string;
}

const ALLOWED_HOST = "detail.1688.com";
const OFFER_PATH_RE = /^\/offer\/(\d+)\.html$/;

export function normalize1688OfferUrl(input: string): Normalized1688Url {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`normalize1688OfferUrl: invalid URL '${input}'`);
  }
  if (url.hostname.toLowerCase() !== ALLOWED_HOST) {
    throw new Error(
      `normalize1688OfferUrl: host '${url.hostname}' is not ${ALLOWED_HOST}`
    );
  }
  const match = OFFER_PATH_RE.exec(url.pathname);
  if (!match || !match[1]) {
    throw new Error(
      `normalize1688OfferUrl: missing /offer/<id>.html path in '${input}'`
    );
  }
  const sourceItemId = match[1];
  // Strip hash, and rebuild without query parameters.
  const canonical = `${url.protocol}//${url.host}${url.pathname}`;
  return Object.freeze({ sourceItemId, canonicalUrl: canonical });
}