import { describe, expect, it } from "vitest";
import { fallbackKey, normalize } from "./remote";

describe("normalize", () => {
  it("every spelling of the same repo normalizes alike", () => {
    for (const form of [
      "git@github.com:agitri/ddd.git",
      "git@github.com:agitri/ddd",
      "https://github.com/agitri/ddd.git",
      "https://github.com/agitri/ddd",
      "https://github.com/agitri/ddd/",
      "ssh://git@github.com/agitri/ddd.git",
      "ssh://git@github.com:22/agitri/ddd.git",
      "https://user:token@github.com/agitri/ddd.git",
      "GitHub.com/Agitri/DDD",
    ]) {
      expect(normalize(form), form).toBe("github.com/agitri/ddd");
    }
  });

  it("different hosts never collide", () => {
    expect(normalize("git@github.com:agitri/ddd.git")).not.toBe(normalize("git@gitlab.com:agitri/ddd.git"));
  });

  it("rejects what it cannot parse", () => {
    expect(normalize("")).toBeNull();
    expect(normalize("   ")).toBeNull();
    expect(normalize("not-a-remote")).toBeNull();
  });

  it("strips .git regardless of case", () => {
    expect(normalize("https://github.com/agitri/DDD.GIT")).toBe("github.com/agitri/ddd");
  });

  it("takes a bracketed IPv6 host as one unit", () => {
    const plain = normalize("git@[2001:db8::1]:agitri/ddd.git");
    const withPort = normalize("ssh://git@[2001:db8::1]:22/agitri/ddd.git");
    expect(plain).not.toBeNull();
    expect(plain).toBe(withPort);
  });
});

describe("fallbackKey", () => {
  it("drops the host", () => {
    for (const form of ["git@github.com:agitri/ddd.git", "https://github.com/agitri/ddd", "https://self-hosted.example.com/agitri/ddd.git"]) {
      expect(fallbackKey(form), form).toBe("agitri/ddd");
    }
  });

  it("cannot tell hosts apart, which is why the UI flags it", () => {
    expect(fallbackKey("git@github.com:agitri/ddd.git")).toBe(fallbackKey("git@gitlab.com:agitri/ddd.git"));
  });

  it("strips .git regardless of case", () => {
    expect(fallbackKey("https://github.com/agitri/DDD.GIT")).toBe("agitri/ddd");
  });

  it("refuses a host/repo pair with no owner", () => {
    expect(fallbackKey("github.com/ddd")).toBeNull();
  });
});
