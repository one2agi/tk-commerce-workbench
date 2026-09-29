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

const ALLOWED_HOST_SUFFIXES = Object.freeze(["alicdn.com", "1688.com"]);

function matchesAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
}

export function parseAllowedSourceImageUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return matchesAllowedHost(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

export function sourceImageProxyPath(value: string): string | null {
  const url = parseAllowedSourceImageUrl(value);
  return url ? `/api/v1/source-images?url=${encodeURIComponent(url.href)}` : null;
}

