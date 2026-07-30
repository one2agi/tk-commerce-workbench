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
