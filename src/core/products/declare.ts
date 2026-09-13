/**
 * Reading what a repo says it can run. Port of `products/declare.rs`.
 *
 * `.ddd/config.json` arrives with a checkout, so every field is read
 * defensively and a malformed entry is dropped rather than allowed to become a
 * button that cannot work. Nothing here executes anything; `consent` answers
 * whether a declaration may run.
 */
import { isAbsolute, join } from "node:path";
import type { ProductDecl } from "../models";

/** A declaration checked against the checkout it came from. */
export interface Declared {
  decl: ProductDecl;
  /** Where it would run. Always inside the project — see `workingDir`. */
  dir: string;
}

/** Keep the declarations that could actually run, in the order declared. */
export function usable(project: string, decls: ProductDecl[]): Declared[] {
  const seen = new Set<string>();
  const out: Declared[] = [];
  for (const d of decls) {
    if (d.id.trim() === "" || d.run.trim() === "") continue;
    // A duplicate id would make two rows fight over one supervision record.
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    const dir = workingDir(project, d.dir);
    if (dir === undefined) continue;
    out.push({ decl: d, dir });
  }
  return out;
}

/**
 * Resolve `dir` against the project root, refusing anything that leaves it.
 *
 * Refuse rather than clamp: a declaration that tried to climb out is not one
 * whose intent we should guess at. Splitting only on `/` mirrors Rust's
 * `Path::components()` on unix, the platform products run on.
 */
export function workingDir(project: string, dir?: string | null): string | undefined {
  const trimmed = dir?.trim() ?? "";
  if (trimmed === "") return project;
  // An absolute path is not "relative to the repo root" by any reading.
  if (isAbsolute(trimmed)) return undefined;
  let resolved = project;
  for (const part of trimmed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return undefined;
    resolved = join(resolved, part);
  }
  return resolved;
}

/** What a product is called on screen. */
export function label(decl: ProductDecl): string {
  const name = decl.name?.trim() ?? "";
  return name !== "" ? name : decl.id;
}
