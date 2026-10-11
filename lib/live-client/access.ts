export function allowLiveRequest(request: Request): boolean {
  try {
    const url = new URL(request.url);
    const host = request.headers.get("host");
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (!host) return false;
    // Next may construct request.url with its internal hostname. Validate the
    // browser-facing Host directly; never trust X-Forwarded-Host/Origin.
    const localOrigin = new URL(`${url.protocol}//${host}`);
    if (localOrigin.host !== host || !["localhost", "127.0.0.1", "[::1]"].includes(localOrigin.hostname)) return false;
    if (request.headers.get("x-mayhem-live") !== "1") return false;
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== localOrigin.origin) return false;
    const site = request.headers.get("sec-fetch-site");
    return site === null || site === "same-origin";
  } catch {
    return false;
  }
}
