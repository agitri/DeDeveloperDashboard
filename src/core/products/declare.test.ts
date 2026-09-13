import { describe, expect, it } from "vitest";
import type { ProductDecl } from "../models";
import { label, usable, workingDir } from "./declare";

const decl = (id: string, run: string): ProductDecl => ({ id, name: null, run, dir: null, port: null });
const withDir = (id: string, dir: string): ProductDecl => ({ ...decl(id, "echo hi"), dir });

describe("declare", () => {
  it("a declaration needs an id and something to run", () => {
    const kept = usable("/p", [decl("", "echo hi"), decl("blank", "   "), decl("ok", "echo hi")]);
    expect(kept.length).toBe(1);
    expect(kept[0]!.decl.id).toBe("ok");
  });

  it("a duplicate id is dropped rather than shown twice", () => {
    const kept = usable("/p", [decl("run", "echo one"), decl("run", "echo two")]);
    expect(kept.length).toBe(1);
    expect(kept[0]!.decl.run).toBe("echo one");
  });

  it("dir defaults to the project root", () => {
    expect(workingDir("/p", null)).toBe("/p");
    expect(workingDir("/p", "  ")).toBe("/p");
  });

  it("a relative dir lands inside the project", () => {
    expect(workingDir("/p", "worker")).toBe("/p/worker");
    expect(workingDir("/p", "./a/b")).toBe("/p/a/b");
  });

  it("a dir that climbs out of the project is refused", () => {
    expect(workingDir("/p", "../../.ssh")).toBeUndefined();
    expect(workingDir("/p", "a/../../b")).toBeUndefined();
    expect(workingDir("/p", "/etc")).toBeUndefined();
    expect(usable("/p", [withDir("escape", "../..")])).toEqual([]);
  });

  it("a product is labelled by its id until it is named", () => {
    expect(label(decl("post-ads", "x"))).toBe("post-ads");
    expect(label({ ...decl("post-ads", "x"), name: "Post ads" })).toBe("Post ads");
    expect(label({ ...decl("post-ads", "x"), name: "  " })).toBe("post-ads");
  });
});
