import { describe, expect, it } from "vitest";
import { recordingEmitter } from "./emitter";

describe("recording emitter", () => {
  it("keeps every event in order", () => {
    const e = recordingEmitter();
    e.emit("ddd://project-changed", { environmentId: "work", projectId: "p1" });
    e.emit("ddd://items-changed", { environmentId: "work" });
    expect(e.events).toEqual([
      { name: "ddd://project-changed", payload: { environmentId: "work", projectId: "p1" } },
      { name: "ddd://items-changed", payload: { environmentId: "work" } },
    ]);
  });
});
