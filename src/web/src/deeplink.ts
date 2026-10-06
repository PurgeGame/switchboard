const PREFIX = "#/s/";

/** Session id from `#/s/<encoded id>`, or null. */
export function parseDeepLink(): string | null {
  if (!location.hash.startsWith(PREFIX)) return null;
  try {
    return decodeURIComponent(location.hash.slice(PREFIX.length)) || null;
  } catch {
    return null;
  }
}

/** Mirrors the selection into the URL without adding history entries or firing hashchange. */
export function writeDeepLink(sessionId: string | null) {
  const hash = sessionId ? PREFIX + encodeURIComponent(sessionId) : "";
  if (location.hash === hash) return;
  history.replaceState(null, "", location.pathname + location.search + hash);
}
