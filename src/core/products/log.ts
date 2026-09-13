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
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
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
  let bytesRead = 0;
  try {
    // `readSync` is not guaranteed to fill the buffer in one call (Rust's
    // `read_to_end` loops for the same reason), so keep reading at the
    // advancing offset until the buffer is full or the file runs out.
    while (bytesRead < CAP_BYTES) {
      const n = readSync(fd, kept, bytesRead, CAP_BYTES - bytesRead, size - CAP_BYTES + bytesRead);
      if (n === 0) break;
      bytesRead += n;
    }
  } finally {
    closeSync(fd);
  }
  const read = kept.subarray(0, bytesRead);
  // Drop the partial first line rather than open on half a word.
  const nl = read.indexOf(0x0a);
  const from = nl === -1 ? 0 : nl + 1;
  writeFileSync(path, read.subarray(from));
}

/** The last `count` lines, for the widget. Reads the whole (capped) file. */
export function tail(path: string, count: number): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  const all = lines(text);
  return all.slice(Math.max(0, all.length - count)).join("\n");
}
