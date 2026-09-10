import { describe, expect, it } from "vitest";
import { applyButton, toggleTask, TOOLBAR_BUTTONS, DEFAULT_TOOLBAR, buttonById } from "./toolbar";

const bold = buttonById("bold")!;
const bullet = buttonById("bullet")!;
const ordered = buttonById("ordered")!;

describe("inline buttons", () => {
  it("wraps a selection and leaves the caret after it", () => {
    const out = applyButton(bold, "say hello there", 4, 9);
    expect(out.text).toBe("say **hello** there");
    expect(out.selStart).toBe(out.selEnd);
    expect(out.text.slice(0, out.selStart)).toBe("say **hello**");
  });

  it("inserts the marker pair with the caret between them when nothing is selected", () => {
    const out = applyButton(bold, "say ", 4, 4);
    expect(out.text).toBe("say ****");
    expect(out.text.slice(0, out.selStart)).toBe("say **");
    expect(out.selStart).toBe(out.selEnd);
  });

  it("unwraps a selection that is already marked", () => {
    const out = applyButton(bold, "say **hello** there", 4, 13);
    expect(out.text).toBe("say hello there");
  });
});

describe("block buttons", () => {
  it("prefixes every selected line, not just the first", () => {
    const out = applyButton(bullet, "one\ntwo\nthree", 0, 13);
    expect(out.text).toBe("- one\n- two\n- three");
  });

  it("returns the original text when toggled twice", () => {
    const source = "one\ntwo\nthree";
    const once = applyButton(bullet, source, 0, source.length);
    const twice = applyButton(bullet, once.text, 0, once.text.length);
    expect(twice.text).toBe(source);
  });

  it("numbers an ordered list rather than repeating 1.", () => {
    const out = applyButton(ordered, "one\ntwo\nthree", 0, 13);
    expect(out.text).toBe("1. one\n2. two\n3. three");
  });

  it("applies to the caret's own line when nothing is selected", () => {
    const out = applyButton(bullet, "one\ntwo", 5, 5);
    expect(out.text).toBe("one\n- two");
  });
});

describe("toggleTask", () => {
  it("flips an open box to done on the addressed line only", () => {
    const source = "- [ ] a\n- [ ] b";
    expect(toggleTask(source, 1)).toBe("- [ ] a\n- [x] b");
  });

  it("flips a done box back to open", () => {
    expect(toggleTask("- [x] a", 0)).toBe("- [ ] a");
  });

  it("leaves a line that is not a task alone", () => {
    expect(toggleTask("plain", 0)).toBe("plain");
  });

  it("ignores a line index that is out of range", () => {
    expect(toggleTask("- [ ] a", 9)).toBe("- [ ] a");
  });
});

describe("the catalog", () => {
  it("has a unique id for every button", () => {
    const ids = TOOLBAR_BUTTONS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("defaults to buttons that all exist in the catalog", () => {
    for (const id of DEFAULT_TOOLBAR) expect(buttonById(id), id).toBeDefined();
  });

  it("returns undefined for an unknown id rather than throwing", () => {
    expect(buttonById("nonsense")).toBeUndefined();
  });
});
