/**
 * Captured output, kept small enough to leave running for a month. Port of
 * `products/log.rs`.
 *
 * A service left up writes a log line every second forever, so the cap is not a
 * nicety. The trim is from the front: the interesting end of a log you glance
 * at is the recent end. It seeks the last `CAP_BYTES` bytes and drops the
 * partial first line — byte work, not string work, so a multi-byte character
 * split at the boundary cannot corrupt the count.
 */
import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lines } from "../dev/run";

/** How much output one product keeps. */
export const CAP_BYTES = 256 * 1024;

/** Where one product's output goes. Keyed by a sanitised product key so an id
 *  out of a repo's config cannot name a path. */
export function file(dir: string, key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_-]/g, "-");
  return join(dir, `${safe}.log`);
}

/**
 * Trim a log back under the cap, keeping the tail. Called before a start, the
 * only moment we are the file's only writer: once the child holds the
 * descriptor, reaching in behind it would be a race we would lose.
 */
export function trim(path: string): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size <= CAP_BYTES) return;

  const fd = openSync(path, "r");
  const kept = Buffer.alloc(CAP_BYTES);
  try {
    readSync(fd, kept, 0, CAP_BYTES, size - CAP_BYTES);
  } finally {
    closeSync(fd);
  }
  // Drop the partial first line rather than open on half a word.
  const nl = kept.indexOf(0x0a);
  const from = nl === -1 ? 0 : nl + 1;
  writeFileSync(path, kept.subarray(from));
}

/** The last `count` lines, for the widget. Reads the whole (capped) file. */
export function tail(path: string, count: number): string {
  let text: string;
  try {
    text = require("node:fs").readFileSync(path, "utf8") as string;
  } catch {
    return "";
  }
  const all = lines(text);
  return all.slice(Math.max(0, all.length - count)).join("\n");
}
