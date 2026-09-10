/**
 * Type-level regression tests for `WidgetPreset`.
 *
 * These assert nothing at runtime — `@ts-expect-error` is the assertion. If one
 * of these literals ever starts compiling, the directive itself becomes an
 * error and `tsc` fails, which is exactly the signal we want: the preset union
 * has gone loose again.
 *
 * The bug being pinned: with `filter?: ItemFilter | RepoFilter` on a single
 * interface, TypeScript accepts any key from any arm, so an `items` preset
 * could carry a `repos` filter key and vice versa. Nothing complained, and
 * the widget quietly showed the wrong slice.
 */
import { describe, expect, it } from "vitest";
import type { WidgetPreset } from "./registry";

describe("WidgetPreset is discriminated on kind", () => {
  it("rejects filter keys from the wrong widget kind", () => {
    const items: WidgetPreset = {
      id: "a",
      name: "A",
      description: "",
      kind: "items",
      // @ts-expect-error `scope` belongs to RepoFilter, not ItemFilter.
      filter: { source: "github", scope: "recent" },
    };

    const repos: WidgetPreset = {
      id: "b",
      name: "B",
      description: "",
      kind: "repos",
      // @ts-expect-error `source` belongs to ItemFilter, not RepoFilter.
      filter: { source: "github" },
    };

    // A clock has no slice to take, so `filter?: undefined` rejects the whole
    // literal rather than the one property — hence the directive sits on the
    // declaration here and on the property above.
    // @ts-expect-error
    const clock: WidgetPreset = {
      id: "c",
      name: "C",
      description: "",
      kind: "clock",
      filter: { source: "github" },
    };

    const typo: WidgetPreset = {
      id: "d",
      name: "D",
      description: "",
      kind: "items",
      // @ts-expect-error `sorce` is a typo; excess-property checking must catch it.
      filter: { sorce: "github" },
    };

    // Referencing them keeps the compiler honest and the linter quiet.
    expect([items, repos, clock, typo]).toHaveLength(4);
  });

  it("accepts each kind with its own filter", () => {
    const ok: WidgetPreset[] = [
      { id: "a", name: "A", description: "", kind: "items", filter: { source: "github" } },
      { id: "b", name: "B", description: "", kind: "repos", filter: { scope: "recent" } },
      { id: "c", name: "C", description: "", kind: "clock" },
    ];
    expect(ok).toHaveLength(3);
  });
});
