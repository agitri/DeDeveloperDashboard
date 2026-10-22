/**
 * What a checkout says it is built on. Port of `eol/detect.rs`.
 *
 * Pure over file contents: every function here takes text and returns
 * declarations, so the whole detection story is testable without a repository,
 * a network, or a clock. `forDir` is the only part that touches the disk.
 *
 * Nothing here guesses. A declaration always names the file it came from and
 * how much that file can be believed — a `Dockerfile` pinning `php:8.1` and a
 * `composer.json` claiming `>=8.4` are not a contradiction to resolve silently.
 * That disagreement is the finding.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlainRecord } from "../json";

/**
 * How much a declaration can be believed. `CONFIDENCE_RANK` is the Rust's
 * derived `Ord` (declared worst to best) made explicit, because TS enums do not
 * carry an order.
 */
export type Confidence = "floor" | "range" | "exact";

export const CONFIDENCE_RANK: Record<Confidence, number> = { floor: 0, range: 1, exact: 2 };

export interface Declaration {
  /**
   * Other files that said the same thing. Agreement is not a finding, so they
   * are folded into one row and listed here.
   *
   * The Rust is `#[serde(skip_serializing_if = "Vec::is_empty")]`. In-process
   * this is always a plain array; the key is omitted at the one boundary that
   * serialises it, `eol/board.ts`'s `Finding`, which is where the Rust's
   * `skip_serializing_if` would fire.
   */
  also: string[];
  /** An endoflife.date product slug. Only ever one from `PRODUCTS`. */
  product: string;
  /** The cycle, in the granularity that product publishes. */
  cycle: string;
  /** The file this came from, relative to the checkout. */
  source: string;
  confidence: Confidence;
  /** What the file actually said, verbatim. */
  raw: string;
}

/**
 * How a product numbers its releases. Not cosmetic: asking endoflife.date about
 * Node cycle `24.20` finds nothing, and about PHP cycle `8` finds nothing
 * either.
 */
export type Granularity = "major" | "majorMinor";

export function granularity(product: string): Granularity {
  switch (product) {
    case "nodejs":
    case "laravel":
    case "nextjs":
    case "dotnet":
      return "major";
    default:
      return "majorMinor";
  }
}

/** Composer packages worth a support date, mapped to their product slug. */
const COMPOSER_PRODUCTS: readonly (readonly [string, string])[] = [
  ["symfony/framework-bundle", "symfony"],
  ["symfony/symfony", "symfony"],
  ["laravel/framework", "laravel"],
  ["php", "php"],
];

/** npm packages worth a support date. */
const NPM_PRODUCTS: readonly (readonly [string, string])[] = [["next", "nextjs"]];

/**
 * Take the version out of a constraint, and say how much it can be believed.
 *
 * `"8.0.*"` is a pin to a line; `">=8.4"` is a floor; `"^16.2.7"` is a range.
 */
export function parseConstraint(raw: string, product: string): { cycle: string; confidence: Confidence } | null {
  const text = raw.trim();
  if (text === "" || text === "*") return null;
  // The first version-looking token. A compound like ">=20 <23" is read as its
  // floor, which is the honest reading: the oldest thing it permits.
  const token = text.split(/[|,\s]/).find((t) => /[0-9]/.test(t));
  if (token === undefined) return null;

  const confidence: Confidence =
    token.startsWith(">=") || token.startsWith(">") ? "floor" : token.startsWith("^") || token.startsWith("~") ? "range" : "exact";

  // Rust's `trim_start_matches(['>', '=', '<', '^', '~', 'v', 'V'])`.
  const digits = token.replace(/^[>=<^~vV]+/, "");
  const cycle = cycleFrom(digits, product);
  if (cycle === null) return null;
  return { cycle, confidence };
}

/** `8.4.3` → `8.4` for PHP, `24.20.0` → `24` for Node. */
export function cycleFrom(version: string, product: string): string | null {
  const parts = version
    .split(/[.\-+]/)
    .map((p) => p.replace(/\*+$/, "")) // Rust's `trim_end_matches('*')`
    .filter((p) => p !== "");
  const major = parts[0];
  if (major === undefined) return null;
  if (!/^[0-9]+$/.test(major)) return null;
  if (granularity(product) === "major") return major;
  const minor = parts[1];
  // A bare major where a minor is expected is not a cycle this API knows.
  // Better no verdict than a verdict about "8".
  if (minor === undefined || !/^[0-9]+$/.test(minor)) return null;
  return `${major}.${minor}`;
}

/** `serde_json::from_str::<Value>` — `undefined` where the Rust gets an `Err`. */
function parseValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** `Value::pointer`, for the two paths this file needs. */
function at(json: unknown, ...path: string[]): unknown {
  let node = json;
  for (const key of path) {
    if (!isPlainRecord(node)) return undefined;
    node = node[key];
  }
  return node;
}

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asObject = (v: unknown): Record<string, unknown> | null => (isPlainRecord(v) ? v : null);

export function parseComposerJson(text: string): Declaration[] {
  const json = parseValue(text);
  if (json === undefined) return [];
  const out: Declaration[] = [];

  // `config.platform.php` is what Composer actually resolves against, so it
  // beats the `require` constraint whenever both are present.
  const platform = asString(at(json, "config", "platform", "php"));
  if (platform !== null) {
    const pinned = cycleFrom(platform, "php");
    if (pinned !== null) {
      out.push({
        also: [],
        product: "php",
        cycle: pinned,
        source: "composer.json",
        confidence: "exact",
        raw: `config.platform.php: ${platform}`,
      });
    }
  }

  for (const section of ["require", "require-dev"]) {
    const map = asObject(at(json, section));
    if (map === null) continue;
    for (const [pkg, product] of COMPOSER_PRODUCTS) {
      // `require-dev` is what the tests run on, not what production runs on.
      // Read it only when `require` said nothing.
      if (section === "require-dev" && out.some((d) => d.product === product)) continue;
      const raw = asString(map[pkg]);
      if (raw === null) continue;
      if (out.some((d) => d.product === product && d.confidence === "exact")) continue;
      const parsed = parseConstraint(raw, product);
      if (parsed === null) continue;
      out.push({
        also: [],
        product,
        cycle: parsed.cycle,
        source: "composer.json",
        confidence: parsed.confidence,
        raw: `${pkg}: ${raw}`,
      });
    }
  }
  return out;
}

export function parsePackageJson(text: string): Declaration[] {
  const json = parseValue(text);
  if (json === undefined) return [];
  const out: Declaration[] = [];

  const engine = asString(at(json, "engines", "node"));
  if (engine !== null) {
    const parsed = parseConstraint(engine, "nodejs");
    if (parsed !== null) {
      out.push({
        also: [],
        product: "nodejs",
        cycle: parsed.cycle,
        source: "package.json",
        confidence: parsed.confidence,
        raw: `engines.node: ${engine}`,
      });
    }
  }
  for (const section of ["dependencies", "devDependencies"]) {
    const map = asObject(at(json, section));
    if (map === null) continue;
    for (const [pkg, product] of NPM_PRODUCTS) {
      if (out.some((d) => d.product === product)) continue;
      const raw = asString(map[pkg]);
      if (raw === null) continue;
      const parsed = parseConstraint(raw, product);
      if (parsed === null) continue;
      out.push({
        also: [],
        product,
        cycle: parsed.cycle,
        source: "package.json",
        confidence: parsed.confidence,
        raw: `${pkg}: ${raw}`,
      });
    }
  }
  return out;
}

/** Rust's `str::lines`: split on `\n`, drop a trailing `\r`. */
function lines(text: string): string[] {
  return text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/**
 * `.nvmrc`, `.python-version`, `.ruby-version` — a pinned toolchain, and the
 * most trustworthy thing in a repository because a human wrote one number.
 */
export function parseVersionFile(name: string, text: string): Declaration[] {
  const product = name === ".nvmrc" ? "nodejs" : name === ".python-version" ? "python" : name === ".ruby-version" ? "ruby" : null;
  if (product === null) return [];
  const line = lines(text)
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#"));
  if (line === undefined) return [];
  // `lts/hydrogen` and friends name a line without numbering it.
  const cycle = cycleFrom(line.replace(/^v+/, ""), product);
  if (cycle === null) return [];
  return [{ also: [], product, cycle, source: name, confidence: "exact", raw: line }];
}

/** `FROM php:8.3-fpm` — the runtime that actually ships. */
export function parseDockerfile(text: string): Declaration[] {
  const images: readonly (readonly [string, string])[] = [
    ["php", "php"],
    ["node", "nodejs"],
    ["python", "python"],
    ["ruby", "ruby"],
    ["golang", "go"],
    ["rust", "rust"],
  ];
  const out: Declaration[] = [];
  for (const raw of lines(text)) {
    const line = raw.trim();
    const rest = line.startsWith("FROM ") ? line.slice(5) : line.startsWith("from ") ? line.slice(5) : null;
    if (rest === null) continue;
    // `FROM x AS builder`, and registry-qualified names.
    let image = rest.trim().split(/\s+/)[0] ?? "";
    image = image.slice(image.lastIndexOf("/") + 1);
    const colon = image.indexOf(":");
    if (colon < 0) continue;
    const name = image.slice(0, colon);
    const tag = image.slice(colon + 1);
    for (const [prefix, product] of images) {
      if (name !== prefix) continue;
      if (out.some((d) => d.product === product)) continue;
      const cycle = cycleFrom(tag, product);
      if (cycle === null) continue;
      out.push({ also: [], product, cycle, source: "Dockerfile", confidence: "exact", raw: `FROM ${image}` });
    }
  }
  return out;
}

/**
 * `requires-python = ">=3.11"`, `go 1.23`, `rust-version = "1.80"`.
 *
 * Read line-wise rather than with a TOML parser: one key from each file, and a
 * dependency for it would be a dependency for three lines of matching.
 */
export function parseTomlLike(name: string, text: string): Declaration[] {
  const pair: [string, string] | null =
    name === "pyproject.toml"
      ? ["requires-python", "python"]
      : name === "Cargo.toml"
        ? ["rust-version", "rust"]
        : name === "go.mod"
          ? ["go", "go"]
          : null;
  if (pair === null) return [];
  const [key, product] = pair;
  for (const raw of lines(text)) {
    const line = raw.trim();
    let value: string | null = null;
    if (name === "go.mod") {
      // `go 1.23` — a directive, not an assignment.
      value = line.startsWith("go ") ? line.slice(3).trim() : null;
    } else if (line.startsWith(key)) {
      const after = line.slice(key.length).trimStart();
      // Rust's `trim_matches('"')`: strip every leading and trailing quote.
      value = after.startsWith("=") ? after.slice(1).trim().replace(/^"+/, "").replace(/"+$/, "") : null;
    }
    if (value === null) continue;
    const parsed = parseConstraint(value, product);
    if (parsed === null) continue;
    return [{ also: [], product, cycle: parsed.cycle, source: name, confidence: parsed.confidence, raw: `${key}: ${value}` }];
  }
  return [];
}

/**
 * Every file this reads. Kept in one list so the widget can say what it looked
 * at when it found nothing.
 */
export const FILES: readonly string[] = [
  "composer.json",
  "package.json",
  ".nvmrc",
  ".python-version",
  ".ruby-version",
  "Dockerfile",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
];

/** Byte-wise, like Rust's `String::cmp`. */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Read a checkout. The only function here that touches the disk.
 *
 * Declarations are sorted by product, then most-trustworthy first, so a
 * `Dockerfile` pin leads and the `composer.json` floor that disagrees with it
 * is still right underneath.
 */
export function forDir(dir: string): Declaration[] {
  const out: Declaration[] = [];
  for (const name of FILES) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (name === "composer.json") out.push(...parseComposerJson(text));
    else if (name === "package.json") out.push(...parsePackageJson(text));
    else if (name === "Dockerfile") out.push(...parseDockerfile(text));
    else if (name === ".nvmrc" || name === ".python-version" || name === ".ruby-version") out.push(...parseVersionFile(name, text));
    else out.push(...parseTomlLike(name, text));
  }
  // `Array.prototype.sort` is stable, as Rust's `sort_by` is.
  out.sort(
    (a, b) =>
      byteCompare(a.product, b.product) || CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] || byteCompare(a.source, b.source),
  );
  return collapseAgreement(out);
}

/**
 * Fold declarations that name the same product *and* the same cycle.
 *
 * A `Dockerfile` pinning PHP 8.1 under a `composer.json` claiming `>=8.4` is
 * the finding and stays two rows. A Dockerfile and a composer file that both
 * say 8.4 are one fact stated twice. The already-sorted order means the
 * survivor is the most trustworthy of the group.
 */
export function collapseAgreement(sorted: Declaration[]): Declaration[] {
  const out: Declaration[] = [];
  for (const declaration of sorted) {
    const kept = out.find((d) => d.product === declaration.product && d.cycle === declaration.cycle);
    if (kept !== undefined) kept.also.push(declaration.source);
    // The Rust moves the declaration in; copying keeps a caller's array from
    // being mutated through the result.
    else out.push({ ...declaration, also: [...declaration.also] });
  }
  return out;
}
