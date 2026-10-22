import { describe, expect, it } from "vitest";
import { DEFAULT_KIND, clickable, toItem, type Mapping } from "./map";
import { parsePage, type Resource } from "./protocol";

function resource(raw: Record<string, unknown>): Resource {
  const [first] = parsePage({ resources: [raw] }).resources;
  if (first === undefined) throw new Error("the test resource did not parse");
  return first;
}

function mapping(): Mapping {
  return {
    environmentId: "default",
    connectionId: "c1",
    kind: DEFAULT_KIND,
    serverName: "files",
    now: "2026-09-04T10:00:00Z",
  };
}

describe("mapping a resource to an item", () => {
  it("only lets web schemes become something a click can open", () => {
    // The URI comes from a third-party server. A `file://` link handed to the
    // operating system is exactly the thing this guard exists to stop.
    expect(clickable("https://example.com/x")).toBe("https://example.com/x");
    expect(clickable("HTTP://example.com")).toBe("HTTP://example.com");
    for (const refused of [
      "file:///etc/passwd",
      "git://github.com/x/y",
      "javascript:alert(1)",
      "custom://thing",
      "data:text/html,<script>",
      "  ",
    ]) {
      expect(clickable(refused), refused).toBeNull();
    }
  });

  it("keeps a refused uri as data rather than letting it vanish", () => {
    const item = toItem(resource({ uri: "file:///notes/a.md", name: "A" }), null, mapping());
    expect(item.url).toBeNull();
    expect(item.refs).toContain("mcp:file:///notes/a.md");
  });

  it("prefers the display name and falls back to the uri last", () => {
    expect(toItem(resource({ uri: "x://1", name: "programmatic", title: "Human Readable" }), null, mapping()).title).toBe("Human Readable");
    expect(toItem(resource({ uri: "x://1", name: "programmatic" }), null, mapping()).title).toBe("programmatic");
    // Nameless is addressable rather than blank.
    expect(toItem(resource({ uri: "x://1" }), null, mapping()).title).toBe("x://1");
    expect(toItem(resource({ uri: "x://1", name: "  " }), null, mapping()).title).toBe("x://1");
  });

  it("lets a read body beat the description, and the description beat nothing", () => {
    expect(toItem(resource({ uri: "x://1", description: "the summary" }), "the whole document", mapping()).body).toBe("the whole document");
    expect(toItem(resource({ uri: "x://1", description: "the summary" }), null, mapping()).body).toBe("the summary");
    expect(toItem(resource({ uri: "x://1" }), null, mapping()).body).toBeNull();
  });

  it("keeps the date a resource gives itself", () => {
    expect(toItem(resource({ uri: "x://1", annotations: { lastModified: "2026-01-02T03:04:05Z" } }), null, mapping()).updatedAt).toBe(
      "2026-01-02T03:04:05Z",
    );
    // Otherwise the sync time, so it sorts somewhere honest rather than at the
    // epoch.
    expect(toItem(resource({ uri: "x://1" }), null, mapping()).updatedAt).toBe("2026-09-04T10:00:00Z");
  });

  it("lets the connection's kind override the generic default", () => {
    // DDD's kinds are a product vocabulary a generic server cannot know, so
    // pointing DDD at an issue tracker means existing widget filters work.
    const item = toItem(resource({ uri: "x://1" }), null, { ...mapping(), kind: "issue" });
    expect(item.kind).toBe("issue");
    expect(item.source).toBe("mcp");
  });

  it("keys on the uri and keeps two servers apart by connection", () => {
    const a = toItem(resource({ uri: "x://1" }), null, mapping());
    const b = toItem(resource({ uri: "x://1" }), null, { ...mapping(), connectionId: "c2" });
    expect(a.id).toBe("c1:x://1");
    expect(a.id).not.toBe(b.id); // the same URI on two servers is two items
  });

  it("carries what the item shape has no field for in refs", () => {
    const item = toItem(resource({ uri: "x://1", mimeType: "text/markdown", annotations: { priority: 0.8 } }), null, mapping());
    expect(item.refs).toContain("mime:text/markdown");
    expect(item.refs).toContain("priority:0.8");
    expect(item.refs).toContain("server:files");
  });

  it("never marks anything from an MCP server unread or actionable", () => {
    // A server has no idea what you have read, and tools are not actions in
    // this version — an item that offered one would be offering something that
    // cannot be performed.
    const item = toItem(resource({ uri: "x://1" }), null, mapping());
    expect(item.unread).toBe(false);
    expect(item.actions).toEqual([]);
  });
});
