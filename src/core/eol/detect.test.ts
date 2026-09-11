import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_RANK,
  cycleFrom,
  forDir,
  parseComposerJson,
  parseDockerfile,
  parsePackageJson,
  parseTomlLike,
  parseVersionFile,
  type Declaration,
} from "./detect";

function tempCheckout(): string {
  return mkdtempSync(join(tmpdir(), "ddd-eol-detect-"));
}

describe("reading what a checkout says it is built on", () => {
  it("the real symfony projects on this machine are read correctly", () => {
    // Verbatim from four of this machine's projects. The 8.0 line is the one
    // whose support ended on 2026-07-31, which is the whole reason this widget
    // exists.
    const declarations = parseComposerJson(
      '{"require": {"php": ">=8.4", "symfony/framework-bundle": "8.0.*"}}',
    );
    const symfony = declarations.find((d) => d.product === "symfony")!;
    expect(symfony.cycle).toBe("8.0");
    expect(symfony.confidence).toBe("exact"); // `8.0.*` pins a release line

    const php = declarations.find((d) => d.product === "php")!;
    expect(php.cycle).toBe("8.4");
    // `>=8.4` says what the code claims to run on, not what is running.
    expect(php.confidence).toBe("floor");
    expect(php.raw).toContain(">=8.4"); // the file's own words are kept
  });

  it("the lts project reads as its own line", () => {
    // toneelPetra, on 7.4 — the LTS, supported until 2029. A "newest version"
    // widget would call this the neglected one.
    const d = parseComposerJson('{"require": {"symfony/framework-bundle": "7.4.*"}}');
    expect(d[0]!.cycle).toBe("7.4");
  });

  it("a platform pin beats the constraint beside it", () => {
    const d = parseComposerJson(
      '{"require": {"php": ">=8.4"}, "config": {"platform": {"php": "8.1.29"}}}',
    );
    const php = d.filter((x) => x.product === "php");
    expect(php).toHaveLength(1); // one answer, the trustworthy one
    expect(php[0]!.cycle).toBe("8.1");
    expect(php[0]!.confidence).toBe("exact");
    expect(php[0]!.raw).toBe("config.platform.php: 8.1.29");
  });

  it("a dev dependency never speaks for production", () => {
    const d = parseComposerJson('{"require-dev": {"symfony/framework-bundle": "6.4.*"}}');
    expect(d[0]!.cycle).toBe("6.4"); // still read when nothing else said anything

    const both = parseComposerJson(
      '{"require": {"symfony/framework-bundle": "8.0.*"}, "require-dev": {"symfony/framework-bundle": "6.4.*"}}',
    );
    const symfony = both.filter((x) => x.product === "symfony");
    expect(symfony).toHaveLength(1);
    expect(symfony[0]!.cycle).toBe("8.0");
  });

  it("an nvmrc is read as a node major", () => {
    // dedesignwinkel, verbatim: a file containing `24`.
    const d = parseVersionFile(".nvmrc", "24\n");
    expect(d[0]!.product).toBe("nodejs");
    expect(d[0]!.cycle).toBe("24"); // Node numbers its cycles by major alone
    expect(d[0]!.confidence).toBe("exact");

    expect(parseVersionFile(".nvmrc", "v20.11.1")[0]!.cycle).toBe("20");
    // A named line is not a number, and inventing one would be worse than
    // saying nothing.
    expect(parseVersionFile(".nvmrc", "lts/hydrogen")).toEqual([]);
  });

  it("a dockerfile pin and a composer floor both survive", () => {
    const all: Declaration[] = parseDockerfile("FROM php:8.1-fpm-alpine AS base\nRUN echo hi\n");
    all.push(...parseComposerJson('{"require": {"php": ">=8.4"}}'));
    expect(all).toHaveLength(2);
    const docker = all.find((d) => d.source === "Dockerfile")!;
    expect(docker.cycle).toBe("8.1");
    expect(docker.confidence).toBe("exact");
    expect(docker.raw).toBe("FROM php:8.1-fpm-alpine");
    // Exact must outrank a floor.
    expect(CONFIDENCE_RANK.exact).toBeGreaterThan(CONFIDENCE_RANK.floor);
    expect(CONFIDENCE_RANK.range).toBeGreaterThan(CONFIDENCE_RANK.floor);
  });

  it("a registry qualified image is still recognised", () => {
    const d = parseDockerfile("FROM docker.io/library/node:22-alpine\n");
    expect(d[0]!.product).toBe("nodejs");
    expect(d[0]!.cycle).toBe("22");
    expect(d[0]!.raw).toBe("FROM node:22-alpine");
  });

  it("an untagged or unrelated image is not a declaration", () => {
    expect(parseDockerfile("FROM alpine:3.19\nFROM scratch\nFROM node\n")).toEqual([]);
  });

  it("node engine ranges read as their floor", () => {
    const d = parsePackageJson('{"engines": {"node": ">=20 <23"}}');
    expect(d[0]!.cycle).toBe("20");
    expect(d[0]!.confidence).toBe("floor"); // the oldest thing it permits
    expect(d[0]!.raw).toBe("engines.node: >=20 <23");

    const caret = parsePackageJson('{"dependencies": {"next": "^16.2.7"}}');
    expect(caret[0]!.product).toBe("nextjs");
    expect(caret[0]!.cycle).toBe("16");
    expect(caret[0]!.confidence).toBe("range");
  });

  it("the toml like files each yield their one key", () => {
    expect(parseTomlLike("go.mod", "module x\n\ngo 1.23\n")[0]!.cycle).toBe("1.23");
    expect(parseTomlLike("go.mod", "module x\n\ngo 1.23\n")[0]!.raw).toBe("go: 1.23");
    expect(parseTomlLike("Cargo.toml", '[package]\nrust-version = "1.80"\n')[0]!.cycle).toBe("1.80");
    const py = parseTomlLike("pyproject.toml", '[project]\nrequires-python = ">=3.11"\n');
    expect(py[0]!.cycle).toBe("3.11");
    expect(py[0]!.confidence).toBe("floor");
    expect(py[0]!.raw).toBe("requires-python: >=3.11");
    expect(parseTomlLike("unknown.toml", "go 1.23")).toEqual([]);
  });

  it("a cycle is asked for in the granularity the product publishes", () => {
    // Asking endoflife.date about Node "24.20" finds nothing, and about PHP "8"
    // finds nothing either. Each of these was read off the real API.
    expect(cycleFrom("24.20.0", "nodejs")).toBe("24");
    expect(cycleFrom("8.4.3", "php")).toBe("8.4");
    expect(cycleFrom("13.0", "laravel")).toBe("13");
    expect(cycleFrom("1.27.1", "go")).toBe("1.27");
    // A bare major where a minor is expected is not a cycle anyone knows.
    expect(cycleFrom("8", "php")).toBeNull();
  });

  it("junk never becomes a declaration", () => {
    expect(parseComposerJson("not json at all")).toEqual([]);
    expect(parsePackageJson("{")).toEqual([]);
    expect(parseComposerJson('{"require": {"php": "*"}}')).toEqual([]);
    expect(parseComposerJson('{"require": {"php": "dev-main"}}')).toEqual([]);
    expect(parseVersionFile(".nvmrc", "\n# a comment\n")).toEqual([]);
    expect(parseVersionFile("unknown-file", "24")).toEqual([]);
  });

  it("a checkout is read whole and ordered by trust", () => {
    const dir = tempCheckout();
    writeFileSync(join(dir, "composer.json"), '{"require": {"php": ">=8.4"}}');
    writeFileSync(join(dir, "Dockerfile"), "FROM php:8.1-fpm\n");
    writeFileSync(join(dir, ".nvmrc"), "24\n");

    const found = forDir(dir);
    expect(found).toHaveLength(3);
    // Same product, most trustworthy first.
    expect(found[0]!.product).toBe("nodejs");
    expect(found[1]!.source).toBe("Dockerfile");
    expect(found[2]!.source).toBe("composer.json");
    rmSync(dir, { recursive: true, force: true });
  });

  it("a directory with nothing in it reads as nothing rather than failing", () => {
    expect(forDir("/nonexistent-checkout-xyz")).toEqual([]);
  });

  it("two files that agree are one finding naming both", () => {
    // A Dockerfile pinning php 8.4 and a composer.json claiming >=8.4. One fact
    // stated twice — showing it twice makes a tidy repo look like a messy one.
    const dir = tempCheckout();
    writeFileSync(join(dir, "composer.json"), '{"require": {"php": ">=8.4"}}');
    writeFileSync(join(dir, "Dockerfile"), "FROM php:8.4-cli-alpine\n");

    const found = forDir(dir);
    expect(found).toHaveLength(1);
    expect(found[0]!.source).toBe("Dockerfile"); // the trustworthy one survives
    expect(found[0]!.confidence).toBe("exact");
    expect(found[0]!.also).toEqual(["composer.json"]); // the other is still named
    rmSync(dir, { recursive: true, force: true });
  });

  it("two files that disagree stay two findings", () => {
    const dir = tempCheckout();
    writeFileSync(join(dir, "composer.json"), '{"require": {"php": ">=8.4"}}');
    writeFileSync(join(dir, "Dockerfile"), "FROM php:8.1-fpm\n");

    const found = forDir(dir);
    expect(found).toHaveLength(2);
    expect(found[0]!.cycle).toBe("8.1");
    expect(found[1]!.cycle).toBe("8.4");
    expect(found[0]!.also).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
