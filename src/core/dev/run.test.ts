import { describe, expect, it } from "vitest";
import { execFileRunner, lines } from "./run";

describe("the process runner", () => {
  it("returns what the process wrote", async () => {
    const out = await execFileRunner("echo", ["hello"]);
    expect(out.ok).toBe(true);
    expect(out.stdout.trim()).toBe("hello");
  });

  it("never rejects when the program is missing — an enumeration that cannot read finds less", async () => {
    const out = await execFileRunner("ddd-no-such-program", ["--version"]);
    expect(out).toEqual({ stdout: "", ok: false });
  });

  it("keeps the output of a process that exited non-zero, the way Command::output does", async () => {
    // `lsof -p` exits 1 when one of the PIDs has gone and still prints the
    // rest, and the Rust parses that stdout regardless of the status.
    const out = await execFileRunner("sh", ["-c", "echo partial; exit 1"]);
    expect(out.stdout.trim()).toBe("partial");
    expect(out.ok).toBe(false);
  });

  it("splits like Rust's str::lines(): no trailing empty, \\r stripped", () => {
    expect(lines("a\nb\n")).toEqual(["a", "b"]);
    expect(lines("a\r\nb")).toEqual(["a", "b"]);
    expect(lines("")).toEqual([]);
    expect(lines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });
});
