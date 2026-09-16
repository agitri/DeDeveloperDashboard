import { describe, expect, it } from "vitest";
import { buildPromotedTab } from "./promote";

describe("buildPromotedTab", () => {
  let n = 0;
  const mint = (p: string) => `${p}-${n++}`;
  const tab = buildPromotedTab(
    { projectId: "proj1", name: "acme", path: "/repos/acme", remote: "github.com/acme/acme" },
    mint,
  );

  it("names the tab for the repo", () => {
    expect(tab.name).toBe("acme");
  });

  it("holds exactly launcher, products, about and notes", () => {
    expect(tab.widgets.map((w) => w.kind).sort()).toEqual(["about", "launcher", "notes", "products"]);
  });

  it("gives the Launcher a terminal and an editor target for the path", () => {
    const launcher = tab.widgets.find((w) => w.kind === "launcher")!;
    const targets = launcher.config.targets as { path: string; open: string }[];
    expect(targets.map((t) => t.open).sort()).toEqual(["ide", "terminal"]);
    expect(targets.every((t) => t.path === "/repos/acme")).toBe(true);
  });

  it("scopes Products and About to the project", () => {
    const products = tab.widgets.find((w) => w.kind === "products")!;
    const about = tab.widgets.find((w) => w.kind === "about")!;
    expect(products.filter.projectId).toBe("proj1");
    expect(about.config.projectId).toBe("proj1");
    expect(about.config.remote).toBe("github.com/acme/acme");
  });

  it("gives the Products widget a title scoping it to the repo", () => {
    const products = tab.widgets.find((w) => w.kind === "products")!;
    expect(products.title).toBeTruthy();
  });

  it("mints unique ids and lays widgets out without overlap", () => {
    const ids = tab.widgets.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    // no two widgets share the same top-left cell
    const cells = tab.widgets.map((w) => `${w.layout.x},${w.layout.y}`);
    expect(new Set(cells).size).toBe(cells.length);
  });
});
