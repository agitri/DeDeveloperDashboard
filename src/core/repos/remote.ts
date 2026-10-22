/**
 * Turning every spelling of a git remote into one stable key. Port of
 * `repos/remote.rs`. This is the join between "a repo on GitHub" and "a folder
 * on disk"; if it is wrong, every repo silently reports as unmapped.
 */

/** `host/owner/repo`, lowercased. The host is part of the key on purpose. */
export function normalize(rawUrl: string): string | null {
  const url = rawUrl.trim();
  if (url === "") return null;

  // Drop the scheme, then any userinfo (`git@`, `user:token@`).
  const schemeAt = url.indexOf("://");
  const withoutScheme = schemeAt >= 0 ? url.slice(schemeAt + 3) : url;
  const at = withoutScheme.lastIndexOf("@");
  const withoutUser = at >= 0 ? withoutScheme.slice(at + 1) : withoutScheme;

  // Split host from path at the first ':' or '/' — except a bracketed IPv6
  // host has to be taken as one unit first.
  let host: string;
  let remainder: string;
  if (withoutUser.startsWith("[")) {
    const close = withoutUser.indexOf("]");
    if (close < 0) return null;
    host = withoutUser.slice(0, close + 1);
    remainder = withoutUser.slice(close + 1);
  } else {
    const index = withoutUser.search(/[:/]/);
    if (index < 0) return null;
    host = withoutUser.slice(0, index);
    remainder = withoutUser.slice(index);
  }
  if (remainder === "") return null;
  const separator = remainder[0];
  remainder = remainder.slice(1);

  // After a ':' the next segment is either a port (`host:22/owner/repo`) or
  // the start of an scp-style path (`host:owner/repo`).
  let path = remainder;
  if (separator === ":") {
    const slash = remainder.indexOf("/");
    if (slash > 0) {
      const maybePort = remainder.slice(0, slash);
      if (/^\d+$/.test(maybePort)) path = remainder.slice(slash + 1);
    }
  }

  path = path.replace(/\/+$/, "");
  // Lowercase before stripping `.git`, not after.
  path = path.toLowerCase();
  if (path.endsWith(".git")) path = path.slice(0, -4);
  if (host === "" || path === "" || !path.includes("/")) return null;
  return `${host.toLowerCase()}/${path}`;
}

/** `owner/repo`, ignoring the host — the weaker second tier. A match made
 *  this way is flagged in the UI rather than presented as certain. */
export function fallbackKey(rawUrl: string): string | null {
  let cleaned = rawUrl.trim().replace(/\/+$/, "").toLowerCase();
  if (cleaned.endsWith(".git")) cleaned = cleaned.slice(0, -4);
  const segments = cleaned
    .split(/[/:]/)
    .filter((s) => s !== "")
    .reverse();
  const repo = segments[0];
  const owner = segments[1];
  if (repo === undefined || owner === undefined) return null;
  if (owner.includes(".") && !owner.includes("/") && segments[2] === undefined) {
    // `github.com/ddd` — the "owner" is really the host; not enough to go on.
    return null;
  }
  return `${owner}/${repo}`;
}
