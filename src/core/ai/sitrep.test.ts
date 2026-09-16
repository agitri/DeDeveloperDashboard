import { describe, expect, it } from "vitest";
import { ACTION, completionFor, type SitrepInput } from "./sitrep";

const input: SitrepInput = {
  projectName: "acme",
  awayDays: 15,
  processesStopped: ["api", "worker"],
  processesRunning: 1,
  commits: 4,
  filesChanged: 12,
  commitMessages: ["fix login", "bump deps"],
  aiActions: [{ action: "mail.draft", count: 2 }],
};

describe("tab.sitrep prompt", () => {
  it("has the stable action id", () => {
    expect(ACTION).toBe("tab.sitrep");
  });
  it("puts the delta facts in the prompt and frames a brief report", () => {
    const c = completionFor(input, "llama3.1:8b");
    expect(c.model).toBe("llama3.1:8b");
    expect(c.prompt).toContain("acme");
    expect(c.prompt).toContain("12"); // files changed
    expect(c.prompt).toContain("api"); // a stopped process
    expect(c.system.toLowerCase()).toContain("situation report");
    expect(c.maxTokens).toBeGreaterThan(0);
  });
});
