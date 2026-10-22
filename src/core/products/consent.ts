/**
 * Approval to run what a repo says it runs. Port of `products/consent.rs`.
 *
 * `.ddd/config.json` arrives with a checkout, so reading one must never be
 * enough to run what it says. The token is `consentToken` unchanged — one
 * implementation of "approval is bound to the exact thing approved" rather than
 * two that could drift apart.
 */
import { DddError } from "../error";
import { isString, record } from "../json";
import { readJson, writeJson } from "../store";
import { consentToken } from "../sync/mcp/transport";

/**
 * What an approval is bound to: the command *and* the directory. The same
 * `python -m worker` in `staging/` and in `production/` are two different
 * programs. `dir` is the directory string exactly as passed — no
 * canonicalization.
 */
export function token(run: string, dir: string): string {
  return consentToken([run.trim(), dir]);
}

/** `<env>/product-approvals.json` — product key to the token approved for it. */
export type Approvals = Record<string, string>;

function approvalsFromJson(raw: unknown): Approvals {
  const o = record(raw, "approvals");
  const out: Approvals = {};
  for (const [k, v] of Object.entries(o)) {
    if (!isString(v)) throw DddError.json(`invalid type for field \`${k}\``);
    out[k] = v;
  }
  return out;
}

/** A missing or unreadable file means nothing is approved — the safe direction
 *  to fail in (Rust's `read_json(..).unwrap_or_default()`). */
export function load(file: string): Approvals {
  try {
    return readJson(file, approvalsFromJson, () => ({}));
  } catch {
    return {};
  }
}

/** Write with keys sorted, so the file matches the Rust's `BTreeMap` output. */
function writeSorted(file: string, approvals: Approvals): void {
  const sorted: Approvals = {};
  for (const key of Object.keys(approvals).sort()) sorted[key] = approvals[key]!;
  writeJson(file, sorted);
}

export function approve(file: string, key: string, tok: string): void {
  const approvals = load(file);
  approvals[key] = tok;
  writeSorted(file, approvals);
}

export function revoke(file: string, key: string): void {
  const approvals = load(file);
  delete approvals[key];
  writeSorted(file, approvals);
}

/** Why a product may not run yet. Both are sentences a widget shows as they
 *  stand — a refusal that cannot explain itself reads as a bug. */
export type Missing = "never" | "changed";

export function missingMessage(m: Missing): string {
  return m === "never" ?
      "not approved to run in this environment yet"
    : "the command changed since you approved it — read it again and approve the new one";
}

/** May this exact command, in this exact directory, run? `null` = yes. */
export function check(approvals: Approvals, key: string, run: string, dir: string): Missing | null {
  const recorded = approvals[key];
  if (recorded === undefined) return "never";
  return recorded === token(run, dir) ? null : "changed";
}
