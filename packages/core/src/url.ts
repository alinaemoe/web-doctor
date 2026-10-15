const TRACKING_PARAM = /^(utm_.+|fbclid|gclid|msclkid|mc_eid|_ga|ref_src)$/i;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT = /^\d+$/;
const HASH_SEGMENT = /^[0-9a-f]{16,}$/i;

/**
 * Normalizes an http(s) URL so the same page always maps to the same string:
 * fragment, credentials and tracking params are dropped, query params are sorted,
 * and a trailing slash on a non-root path is removed.
 * Host case and default ports are already normalized by `URL`.
 * Returns `null` for anything that is not a valid http(s) URL.
 */
export function normalizeUrl(input: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hash = "";
  url.username = "";
  url.password = "";

  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM.test(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [key, value] of params) url.searchParams.append(key, value);

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  }
  return url.toString();
}

export function isSameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Origin-independent page key (`path?query`) used in fingerprints, so staging and prod compare. */
export function pageKey(url: string): string {
  const normalized = normalizeUrl(url);
  if (!normalized) return url;
  const parsed = new URL(normalized);
  return `${parsed.pathname}${parsed.search}`;
}

/** `/products/123` -> `/products/:id`. Used to guess page templates for grouping. */
export function pathTemplate(url: string): string {
  const normalized = normalizeUrl(url);
  if (!normalized) return url;
  const { pathname } = new URL(normalized);
  return pathname
    .split("/")
    .map((segment) =>
      NUMERIC_SEGMENT.test(segment) || UUID_SEGMENT.test(segment) || HASH_SEGMENT.test(segment)
        ? ":id"
        : segment,
    )
    .join("/");
}
