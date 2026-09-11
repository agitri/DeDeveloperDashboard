/**
 * The repos widget's filter. Port of `RepoFilter` in `repos/mod.rs`.
 *
 * `Serialize` too in the Rust: a compiled widget instruction is stored back
 * into `layout.json` as one of these, so absent fields must stay absent (no
 * `null`s written out).
 */
import { DddError } from "../error";
import { isString, record } from "../json";

export interface RepoFilter {
  /** `recent` (default) or `all`. */
  scope?: string;
  query?: string;
}

export function repoFilterFromJson(raw: unknown): RepoFilter {
  const o = record(raw, "filter");
  const out: RepoFilter = {};
  for (const key of ["scope", "query"] as const) {
    const v = o[key];
    if (v === undefined || v === null) continue;
    if (!isString(v)) throw DddError.json(`invalid type for field \`${key}\``);
    out[key] = v;
  }
  return out;
}
