/**
 * Reading and writing the JSON files that *are* the config. Port of `store.rs`.
 *
 * Writes go through a temp file + rename so a crash mid-save can never leave a
 * half-written layout behind.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DddError, isNotFound } from "./error";

/** The file's JSON value, or null when the file is missing or blank. */
export function readJsonOpt(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (isNotFound(e)) return null;
    throw DddError.io(e);
  }
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw DddError.json(e);
  }
}

/**
 * Rust's `read_json<T: Default>`: missing or blank → the default; otherwise
 * the parsed value passed through `fromJson`, which is where serde's per-field
 * defaults live on this side.
 */
export function readJson<T>(path: string, fromJson: (raw: unknown) => T, fallback: () => T): T {
  const raw = readJsonOpt(path);
  return raw === null ? fallback() : fromJson(raw);
}

/** Pretty-printed: these files are meant to be opened, diffed and shared. */
export function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const text = JSON.stringify(value, null, 2);
    // `settings.json` stages as `settings.json.tmp`, as the Rust does.
    const tmp = path.replace(/\.json$/, "") + ".json.tmp";
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (e) {
    if (e instanceof DddError) throw e;
    throw DddError.io(e);
  }
}
