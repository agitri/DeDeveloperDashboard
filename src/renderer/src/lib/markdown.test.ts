import { describe, expect, it } from "vitest";
import { parse, type Block, type Inline } from "./markdown";

/** Flatten every inline node to its literal text, marks and all. */
function textOf(kids: Inline[]): string {
  return kids
    .map((k) =>
      k.t === "text" ? k.v
      : k.t === "code" ? k.v
      : "kids" in k ? textOf(k.kids)
      : "",
    )
    .join("");
}

/** Narrow to the inline children of whichever block kinds have them. */
function kidsOf(block: Block | undefined): Inline[] {
  if (block && "kids" in block && Array.isArray(block.kids)) return block.kids;
  throw new Error(`block ${block?.t ?? "undefined"} has no inline children`);
}

function marks(kids: Inline[]): string[] {
  return kids.flatMap((k) => (k.t === "text" ? [] : [k.t, ...("kids" in k ? marks(k.kids) : [])]));
}

describe("blocks", () => {
  it("parses headings at every level", () => {
    for (let level = 1; level <= 6; level++) {
      const [block] = parse(`${"#".repeat(level)} Title`);
      expect(block).toMatchObject({ t: "heading", level });
      expect(textOf(kidsOf(block))).toBe("Title");
    }
  });

  it("does not treat seven hashes as a heading", () => {
    expect(parse("####### nope")[0]!.t).toBe("para");
  });

  it("parses both list kinds", () => {
    const bullet = parse("- one\n- two")[0]!;
    expect(bullet).toMatchObject({ t: "list", ordered: false });
    const ordered = parse("1. one\n2. two")[0]!;
    expect(ordered).toMatchObject({ t: "list", ordered: true });
  });

  it("parses task items in both states and records their source line", () => {
    const list = parse("intro\n\n- [ ] open\n- [x] done")[1]!;
    if (list.t !== "list") throw new Error("expected a list");
    expect(list.items[0]!.task).toEqual({ checked: false, line: 2 });
    expect(list.items[1]!.task).toEqual({ checked: true, line: 3 });
    expect(textOf(list.items[0]!.kids)).toBe("open");
  });

  it("leaves a plain bullet with no task marker", () => {
    const list = parse("- plain")[0]!;
    if (list.t !== "list") throw new Error("expected a list");
    expect(list.items[0]!.task).toBeNull();
  });

  it("parses quotes, fenced code and rules", () => {
    expect(parse("> quoted")[0]).toMatchObject({ t: "quote" });
    expect(parse("```ts\nlet x = 1\n```")[0]).toMatchObject({
      t: "code",
      lang: "ts",
      v: "let x = 1",
    });
    for (const rule of ["---", "***", "___"]) {
      expect(parse(rule)[0], rule).toMatchObject({ t: "rule" });
    }
  });

  it("joins consecutive lines into one paragraph and splits on a blank line", () => {
    const blocks = parse("one\ntwo\n\nthree");
    expect(blocks).toHaveLength(2);
    expect(textOf(kidsOf(blocks[0]))).toBe("one two");
  });
});

describe("inline marks", () => {
  it("parses each mark", () => {
    expect(marks(kidsOf(parse("**b**")[0]))).toContain("bold");
    expect(marks(kidsOf(parse("*i*")[0]))).toContain("italic");
    expect(marks(kidsOf(parse("_i_")[0]))).toContain("italic");
    expect(marks(kidsOf(parse("~~s~~")[0]))).toContain("strike");
    expect(marks(kidsOf(parse("`c`")[0]))).toContain("code");
    expect(marks(kidsOf(parse("[t](https://x.dev)")[0]))).toContain("link");
  });

  it("nests marks inside a list item and inside a heading", () => {
    const list = parse("- a **bold** word")[0]!;
    if (list.t !== "list") throw new Error("expected a list");
    expect(marks(list.items[0]!.kids)).toContain("bold");
    expect(marks(kidsOf(parse("# a `code` title")[0]))).toContain("code");
  });

  it("does not parse marks inside inline code", () => {
    const kids = kidsOf(parse("`**not bold**`")[0]);
    expect(marks(kids)).toEqual(["code"]);
    expect(textOf(kids)).toBe("**not bold**");
  });

  it("leaves an unmatched delimiter as literal text", () => {
    expect(textOf(kidsOf(parse("**unclosed")[0]))).toBe("**unclosed");
    expect(marks(kidsOf(parse("**unclosed")[0]))).toEqual([]);
  });
});

describe("safety", () => {
  it("keeps raw HTML as text, never as an element", () => {
    const kids = kidsOf(parse("<script>alert(1)</script>")[0]);
    expect(kids.every((k) => k.t === "text")).toBe(true);
    expect(textOf(kids)).toBe("<script>alert(1)</script>");
  });

  it("refuses a javascript: link and renders it as text", () => {
    // Rendering to React elements removes the innerHTML injection surface, but
    // an href is still executable. This is the one place a link can bite.
    const kids = kidsOf(parse("[click](javascript:alert(1))")[0]);
    expect(marks(kids)).toEqual([]);
    expect(textOf(kids)).toBe("[click](javascript:alert(1))");
  });

  it("allows http, https and mailto links", () => {
    for (const href of ["http://x.dev", "https://x.dev", "mailto:a@b.dev"]) {
      expect(marks(kidsOf(parse(`[t](${href})`)[0])), href).toContain("link");
    }
  });
});

describe("totality", () => {
  it("never throws, whatever it is handed", () => {
    const odd = ["", "[", "***", "- [ ", "#", "```", "```ts", "~~", "](", "1.", ">", "____"];
    for (const input of odd) expect(() => parse(input), JSON.stringify(input)).not.toThrow();
  });

  it("returns no blocks for empty input", () => {
    expect(parse("")).toEqual([]);
    expect(parse("   \n\n  ")).toEqual([]);
  });

  it("treats an unclosed fence as text rather than swallowing the rest", () => {
    const blocks = parse("```\nstill text");
    expect(blocks.every((b) => b.t !== "code")).toBe(true);
  });
});
