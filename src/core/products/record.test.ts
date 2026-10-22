import { describe, expect, it } from "vitest";
import { claim, recordFromJson, stateOf, type ProcInfo, type Record } from "./record";

const record = (): Record => ({
  key: "proj/post-ads",
  projectId: "proj",
  productId: "post-ads",
  pid: 4821,
  startedAt: "Wed Sep 10 09:14:03 2026",
  command: "zsh",
  since: "2026-09-10T09:14:03Z",
});

const info = (startedAt: string, command: string): ProcInfo => ({ startedAt, command });

describe("record", () => {
  it("a pid that started when we say is ours", () => {
    expect(claim(record(), info("Wed Sep 10 09:14:03 2026", "zsh"))).toEqual({ kind: "ours" });
  });

  it("a shell that execd into the command is still ours", () => {
    // One process: `zsh -l -c "python …"` becomes `python3` the moment the
    // shell execs, same pid and same start time. The command name is not gated.
    expect(claim(record(), info("Wed Sep 10 09:14:03 2026", "python3"))).toEqual({ kind: "ours" });
  });

  it("a recycled pid is refused not adopted", () => {
    expect(claim(record(), info("Tue Sep 16 11:02:55 2026", "Slack")).kind).toBe("reused");
  });

  it("nothing at the pid means it exited", () => {
    expect(claim(record(), null)).toEqual({ kind: "gone" });
    expect(claim(record(), undefined)).toEqual({ kind: "gone" });
  });

  it("a reused pid is never drawn as running", () => {
    expect(stateOf(record(), info("Tue Sep 16 11:02:55 2026", "Slack")).state).toBe("unknown");
  });

  it("no record is stopped rather than unknown", () => {
    expect(stateOf(undefined, null)).toEqual({ state: "stopped" });
  });

  it("a record with no process reads as exited", () => {
    expect(stateOf(record(), null)).toEqual({ state: "exited", since: "2026-09-10T09:14:03Z" });
  });

  it("a running record carries pid and since", () => {
    expect(stateOf(record(), info("Wed Sep 10 09:14:03 2026", "zsh"))).toEqual({
      state: "running",
      pid: 4821,
      since: "2026-09-10T09:14:03Z",
    });
  });

  it("recordFromJson defaults a missing command to empty", () => {
    const r = recordFromJson({
      key: "p/x",
      projectId: "p",
      productId: "x",
      pid: 7,
      startedAt: "S",
      since: "T",
    });
    expect(r.command).toBe("");
    expect(Object.keys(r)).toEqual(["key", "projectId", "productId", "pid", "startedAt", "command", "since"]);
  });
});
