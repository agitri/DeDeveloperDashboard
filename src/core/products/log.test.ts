import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CAP_BYTES, file, tail, trim } from "./log";

const temp = () => mkdtempSync(join(tmpdir(), "ddd-log-"));

describe("log", () => {
  it("a product id can never name a path", () => {
    const f = file("/logs", "../../.ssh/authorized_keys");
    expect(dirname(f)).toBe("/logs");
    expect(f.includes("..")).toBe(false);
  });

  it("an ordinary key stays readable", () => {
    expect(file("/logs", "proj-post_ads")).toBe("/logs/proj-post_ads.log");
  });

  it("a small log is left alone", () => {
    const path = join(temp(), "small.log");
    writeFileSync(path, "one\ntwo\n");
    trim(path);
    expect(readFileSync(path, "utf8")).toBe("one\ntwo\n");
  });

  it("a month of output is cut back to the recent end", () => {
    const path = join(temp(), "big.log");
    const line = "a service saying something\n";
    writeFileSync(path, line.repeat(Math.floor(CAP_BYTES / line.length) + 5000));
    expect(statSync(path).size).toBeGreaterThan(CAP_BYTES);

    trim(path);

    const after = readFileSync(path, "utf8");
    expect(Buffer.byteLength(after)).toBeLessThanOrEqual(CAP_BYTES);
    // The tail survived and starts on a line boundary, not mid-word.
    expect(after.endsWith(line)).toBe(true);
    expect(after.startsWith("a service")).toBe(true);
  });

  it("tail reads the end and survives a missing file", () => {
    const path = join(temp(), "tail.log");
    writeFileSync(path, "one\ntwo\nthree\nfour\n");
    expect(tail(path, 2)).toBe("three\nfour");
    expect(tail(join(temp(), "nope.log"), 5)).toBe("");
  });

  it("a non-word key basename stays put", () => {
    // Sanity: sanitisation keeps the file in the given directory.
    const f = file("/logs", "proj/svc");
    expect(dirname(f)).toBe("/logs");
    expect(basename(f)).toBe("proj-svc.log");
  });
});
