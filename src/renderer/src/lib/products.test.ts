import { describe, expect, it } from "vitest";
import { blocker, byProject, since, verdict } from "./products";
import type { Product } from "../types";

const product = (over: Partial<Product> = {}): Product => ({
  key: "p/x",
  projectId: "p",
  productId: "x",
  name: "X",
  run: "echo hi",
  dir: "/p",
  port: null,
  dirExists: true,
  needsApproval: null,
  state: { state: "stopped" },
  log: "",
  ...over,
});

describe("how a product reads on the board", () => {
  it("never draws an unverified process as up", () => {
    // The standing rule, and the case it was written for: a supervision record
    // whose PID no longer checks out is not a running product.
    const v = verdict({ state: "unknown", why: "pid 40122 belongs to Slack now" });
    expect(v.state).toBe("unknown");
    expect(v.label).toBe("unknown");
    expect(v.title).toContain("Slack");
  });

  it("does not call a finished run a failure", () => {
    // A job that ended is the normal end of a job. The widget cannot know
    // whether this one was meant to stay up, so it does not editorialise.
    const v = verdict({ state: "exited", since: new Date().toISOString() });
    expect(v.state).not.toBe("err");
    expect(v.state).not.toBe("down");
    expect(v.label).toBe("exited");
  });

  it("does not paint a product at rest as broken", () => {
    // It rendered red at first. A product nobody has started is not a failure,
    // and a board full of red marks for things nobody did wrong is a board you
    // stop reading.
    const v = verdict({ state: "stopped" });
    expect(v.label).toBe("not running");
    expect(v.state).not.toBe("down");
    expect(v.state).not.toBe("err");
  });

  it("tells at-rest and finished apart in words, since both are neutral", () => {
    // Colour is never the only carrier — these two share a colour on purpose.
    const stopped = verdict({ state: "stopped" });
    const exited = verdict({ state: "exited", since: new Date().toISOString() });
    expect(stopped.state).toBe(exited.state);
    expect(stopped.label).not.toBe(exited.label);
  });

  it("shows the pid on a running product without putting it in the label", () => {
    const v = verdict({ state: "running", pid: 40122, since: new Date().toISOString() });
    expect(v.state).toBe("up");
    expect(v.title).toContain("40122");
    expect(v.label).toBe("up");
  });
});

describe("uptime", () => {
  const now = Date.parse("2026-09-10T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("reads in the units a glance uses", () => {
    expect(since(ago(30_000), now)).toBe("just now");
    expect(since(ago(5 * 60_000), now)).toBe("5m");
    expect(since(ago(3 * 3_600_000), now)).toBe("3h");
    expect(since(ago(50 * 3_600_000), now)).toBe("2d");
  });

  it("says nothing rather than something wrong", () => {
    // A record written before a clock change, or a garbled timestamp.
    expect(since("not a date", now)).toBe("");
    expect(since(new Date(now + 60_000).toISOString(), now)).toBe("");
  });
});

describe("why a product cannot start", () => {
  it("names the missing checkout, which is the common one", () => {
    expect(blocker(product({ dirExists: false }))).toContain("not there");
  });

  it("passes the approval refusal through as the sentence it already is", () => {
    const why = "not approved to run in this environment yet";
    expect(blocker(product({ needsApproval: why }))).toBe(why);
  });

  it("reports the missing directory ahead of the approval", () => {
    // Approving a command whose directory is gone would teach you nothing.
    const both = product({ dirExists: false, needsApproval: "not approved" });
    expect(blocker(both)).toContain("not there");
  });

  it("has nothing to say about a product that can run", () => {
    expect(blocker(product())).toBeNull();
  });
});

describe("grouping", () => {
  it("keeps projects and their declaration order", () => {
    const groups = byProject([
      product({ key: "a/1", projectId: "a" }),
      product({ key: "b/1", projectId: "b" }),
      product({ key: "a/2", projectId: "a" }),
    ]);
    expect(groups.map((g) => g.projectId)).toEqual(["a", "b"]);
    expect(groups[0]!.products.map((p) => p.key)).toEqual(["a/1", "a/2"]);
  });
});
