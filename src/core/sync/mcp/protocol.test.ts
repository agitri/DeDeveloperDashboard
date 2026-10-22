import { describe, expect, it } from "vitest";
import {
  BODY_CAP,
  PAGE_CAP,
  PROTOCOL_VERSION,
  READ_BUDGET,
  isForHumans,
  parseContents,
  parseInitialize,
  parsePage,
  parseTools,
  shouldRead,
  truncate,
  type Resource,
} from "./protocol";

/** The Rust test module's `resource(json)`, through the parser so the tests
 *  exercise the same tolerant path the client does. */
function resource(raw: Record<string, unknown>): Resource {
  const [first] = parsePage({ resources: [raw] }).resources;
  if (first === undefined) throw new Error("the test resource did not parse");
  return first;
}

describe("the constants DDD speaks", () => {
  it("declares one version and two budgets", () => {
    expect(PROTOCOL_VERSION).toBe("2025-06-18");
    expect(PAGE_CAP).toBe(20);
    expect(READ_BUDGET).toBe(40);
    expect(BODY_CAP).toBe(65536);
  });
});

describe("the audience filter", () => {
  it("does not put a resource for models alone on this board", () => {
    // The one line of filtering that is the whole positioning: DDD is an
    // overview, not an agent, so it syncs what a person is meant to see.
    expect(isForHumans(resource({ uri: "x://1", annotations: { audience: ["assistant"] } }))).toBe(false);
    expect(isForHumans(resource({ uri: "x://1", annotations: { audience: ["user"] } }))).toBe(true);
    expect(isForHumans(resource({ uri: "x://1", annotations: { audience: ["user", "assistant"] } }))).toBe(true);
  });

  it("treats silence about audience as 'a person may see it'", () => {
    // `audience` is optional in the specification. Treating its absence as
    // "for models" would empty most boards.
    expect(isForHumans(resource({ uri: "x://1" }))).toBe(true);
    expect(isForHumans(resource({ uri: "x://1", annotations: {} }))).toBe(true);
    expect(isForHumans(resource({ uri: "x://1", annotations: { audience: [] } }))).toBe(true);
  });
});

describe("a listing page", () => {
  it("reports its cursor and drops only the unusable", () => {
    const page = parsePage({
      resources: [{ uri: "x://1", name: "one" }, { name: "no uri at all" }, { uri: "   " }, { uri: "x://2" }],
      nextCursor: "abc",
    });
    expect(page.resources).toHaveLength(2); // one bad resource must not cost a page
    expect(page.nextCursor).toBe("abc");

    // An empty cursor is not a cursor, and following it would loop forever.
    expect(parsePage({ resources: [], nextCursor: "" }).nextCursor).toBeNull();
    expect(parsePage({}).nextCursor).toBeNull();
    expect(parsePage({}).resources).toEqual([]);
  });

  it("drops an entry whose fields are the wrong type, as serde does", () => {
    expect(parsePage({ resources: [{ uri: "x://1", size: "big" }, { uri: "x://2" }] }).resources).toHaveLength(1);
  });
});

describe("the handshake", () => {
  it("is reduced to what Settings shows", () => {
    const info = parseInitialize(
      { resources: { subscribe: true, listChanged: false }, tools: {} },
      { name: "files", version: "1.2.0" },
      "2025-06-18",
    );
    expect(info.name).toBe("files");
    expect(info.version).toBe("1.2.0");
    expect(info.protocolVersion).toBe("2025-06-18");
    expect(info.hasResources && info.hasTools && info.subscribe).toBe(true);
    expect(info.listChanged).toBe(false);
  });

  it("calls a server with no resources valid, and says so", () => {
    // Not an error: a connection that yields nothing is a fact Settings can
    // state plainly, and calling it broken would be wrong.
    const info = parseInitialize({ tools: {} }, undefined, "");
    expect(info.hasResources).toBe(false);
    expect(info.hasTools).toBe(true);
    expect(info.name).toBe("unnamed server"); // a nameless server still gets a label
    expect(info.version).toBe("");
    expect(parseInitialize(undefined, undefined, "").hasTools).toBe(false);
  });
});

describe("contents", () => {
  it("joins text parts and yields nothing for a binary one", () => {
    expect(
      parseContents({
        contents: [
          { uri: "x://1", text: "first" },
          { uri: "x://1", text: "second" },
        ],
      }),
    ).toBe("first\n\nsecond");
    // A blob still becomes an item — with no body, and its MIME in refs.
    expect(parseContents({ contents: [{ uri: "x://1", blob: "aGk=", mimeType: "image/png" }] })).toBeNull();
    expect(parseContents({ contents: [] })).toBeNull();
    expect(parseContents({})).toBeNull();
  });
});

describe("truncation", () => {
  it("cuts a huge body on a character boundary and admits it", () => {
    const long = "é".repeat(BODY_CAP);
    const cut = truncate(long, BODY_CAP);
    expect(cut.endsWith("… truncated")).toBe(true);
    // `String::len` is bytes in the Rust, so this assertion is on bytes too.
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(BODY_CAP + 20);
    // And a short one is returned untouched, with no note.
    expect(truncate("short", BODY_CAP)).toBe("short");
  });

  it("backs off a cut that would land inside a character", () => {
    // "éé" is four bytes; a cap of three would split the second one.
    expect(truncate("éé", 3)).toBe("é\n\n… truncated");
  });
});

describe("the read budget", () => {
  it("is spent only where it buys something", () => {
    // A description is already a body; spending a round trip to replace it is
    // the cost this budget exists to avoid.
    expect(shouldRead(resource({ uri: "x://1", description: "already have this" }))).toBe(false);
    expect(shouldRead(resource({ uri: "x://1" }))).toBe(true);
    expect(shouldRead(resource({ uri: "x://1", mimeType: "text/markdown" }))).toBe(true);
    expect(shouldRead(resource({ uri: "x://1", mimeType: "application/json" }))).toBe(true);
  });

  it("is never spent on the binary or the enormous", () => {
    expect(shouldRead(resource({ uri: "x://1", mimeType: "image/png" }))).toBe(false);
    expect(shouldRead(resource({ uri: "x://1", mimeType: "application/octet-stream" }))).toBe(false);
    expect(shouldRead(resource({ uri: "x://1", mimeType: "text/plain", size: 999999999 }))).toBe(false);
    // A blank description is not a description.
    expect(shouldRead(resource({ uri: "x://1", description: "  " }))).toBe(true);
  });
});

describe("tools", () => {
  it("are read for listing and nothing else", () => {
    const tools = parseTools({
      tools: [{ name: "search", description: "find things" }, { name: "write" }, { description: "nameless, therefore not a tool" }],
    });
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe("search");
    expect(tools[1]!.description).toBeNull();
    expect(parseTools({})).toEqual([]);
  });
});
