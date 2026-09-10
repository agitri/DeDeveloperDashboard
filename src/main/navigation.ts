/**
 * Where the window may navigate: nowhere but its own page.
 *
 * Electron reports `location.reload()` as a `will-navigate` to the page's own
 * URL, so "block every navigation" also blocks the reload the "Look changed"
 * toast performs — and the Console look never appears. Same origin and same
 * path is the app itself (a `?look=` query is allowed, as the renderer's
 * `look.ts` reads one); anything else leaves the app and is refused.
 */
export function allowNavigation(currentUrl: string, targetUrl: string): boolean {
  let current: URL;
  let target: URL;
  try {
    current = new URL(currentUrl);
    target = new URL(targetUrl);
  } catch {
    return false;
  }
  return target.protocol === current.protocol && target.host === current.host && target.pathname === current.pathname;
}
