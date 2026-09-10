import { beforeEach, describe, expect, it } from "vitest";
import { forgetAll, remember, remembered } from "./remembered";

describe("remembered", () => {
  beforeEach(forgetAll);

  it("hands back what a view last held", () => {
    // The property the whole module exists for: a widget remounting after a
    // tab switch starts from its last answer instead of from nothing.
    remember("repos:default:w-1", [{ id: "a" }]);
    expect(remembered("repos:default:w-1")).toEqual([{ id: "a" }]);
  });

  it("knows nothing about a view it has not seen", () => {
    // Which is what makes the first visit honest: no data is not empty data.
    expect(remembered("repos:default:w-1")).toBeUndefined();
  });

  it("keeps environments apart", () => {
    // The key carries the environment because §5.9's wall applies here too:
    // Work's repositories must never paint into Personal for a frame.
    remember("repos:work:w-1", ["work repo"]);
    remember("repos:personal:w-1", ["personal repo"]);
    expect(remembered("repos:work:w-1")).toEqual(["work repo"]);
    expect(remembered("repos:personal:w-1")).toEqual(["personal repo"]);
  });

  it("forgets everything when asked", () => {
    remember("a", 1);
    forgetAll();
    expect(remembered("a")).toBeUndefined();
  });

  it("holds the value it was given, not a copy of it", () => {
    // Widgets set state with new arrays every load, so identity is what tells
    // a re-render from a genuine change.
    const rows = [{ id: "a" }];
    remember("k", rows);
    expect(remembered("k")).toBe(rows);
  });
});
