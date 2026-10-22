/**
 * The notes formatting toolbar: a fixed catalog, a per-widget selection.
 *
 * The catalog is fixed because `markdown.ts` has to be able to parse whatever
 * any button can produce. A button that could be enabled later but not parsed
 * today would write text the note renders as gibberish.
 *
 * The transforms are pure functions over `(text, selectionStart, selectionEnd)`
 * so they can be tested without a DOM.
 */

export type Edit = { text: string; selStart: number; selEnd: number };

export type ToolbarButton = {
  id: string;
  /** What the button shows. Short — this is a dense strip. */
  label: string;
  title: string;
} & (
  | { kind: "inline"; marker: string }
  | { kind: "block"; prefix: (n: number) => string; match: RegExp }
  | { kind: "insert"; snippet: string; caretOffset: number }
);

const bullet = { prefix: () => "- ", match: /^[-*+] / };

export const TOOLBAR_BUTTONS: ToolbarButton[] = [
  { id: "bold", label: "B", title: "Bold", kind: "inline", marker: "**" },
  { id: "italic", label: "I", title: "Italic", kind: "inline", marker: "*" },
  { id: "strike", label: "S", title: "Strikethrough", kind: "inline", marker: "~~" },
  { id: "code", label: "`", title: "Inline code", kind: "inline", marker: "`" },
  { id: "h1", label: "H1", title: "Heading 1", kind: "block", prefix: () => "# ", match: /^# / },
  { id: "h2", label: "H2", title: "Heading 2", kind: "block", prefix: () => "## ", match: /^## / },
  { id: "h3", label: "H3", title: "Heading 3", kind: "block", prefix: () => "### ", match: /^### / },
  { id: "bullet", label: "•", title: "Bulleted list", kind: "block", ...bullet },
  {
    id: "ordered",
    label: "1.",
    title: "Numbered list",
    kind: "block",
    prefix: (n) => `${n + 1}. `,
    match: /^\d+[.)] /,
  },
  {
    id: "task",
    label: "☐",
    title: "Task list",
    kind: "block",
    prefix: () => "- [ ] ",
    match: /^[-*+] \[[ xX]\] /,
  },
  { id: "quote", label: "❝", title: "Quote", kind: "block", prefix: () => "> ", match: /^> / },
  {
    id: "link",
    label: "↗",
    title: "Link",
    kind: "insert",
    snippet: "[](https://)",
    caretOffset: 1,
  },
  { id: "rule", label: "—", title: "Horizontal rule", kind: "insert", snippet: "\n---\n", caretOffset: 5 },
  {
    id: "codeblock",
    label: "{}",
    title: "Code block",
    kind: "insert",
    snippet: "```\n\n```",
    caretOffset: 4,
  },
];

/** What a note shows before anyone customises it. */
export const DEFAULT_TOOLBAR = ["bold", "italic", "h2", "bullet", "task", "link", "code"];

export function buttonById(id: string): ToolbarButton | undefined {
  return TOOLBAR_BUTTONS.find((b) => b.id === id);
}

export function applyButton(button: ToolbarButton, text: string, selStart: number, selEnd: number): Edit {
  if (button.kind === "inline") return inline(button.marker, text, selStart, selEnd);
  if (button.kind === "block") return block(button, text, selStart, selEnd);
  return {
    text: text.slice(0, selStart) + button.snippet + text.slice(selEnd),
    selStart: selStart + button.caretOffset,
    selEnd: selStart + button.caretOffset,
  };
}

function inline(marker: string, text: string, selStart: number, selEnd: number): Edit {
  const selected = text.slice(selStart, selEnd);

  // Already marked? Then this is an un-mark. Pressing Bold on bold text
  // meaning "more bold" would be a trap with no way back out.
  if (selected.length >= marker.length * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(marker.length, selected.length - marker.length);
    return {
      text: text.slice(0, selStart) + inner + text.slice(selEnd),
      selStart,
      selEnd: selStart + inner.length,
    };
  }

  const wrapped = marker + selected + marker;
  const after = selStart + wrapped.length;
  // With a selection the caret lands past the closing marker so typing
  // continues unformatted; with none it lands between the markers, ready to
  // type the thing being formatted.
  const caret = selected ? after : selStart + marker.length;
  return {
    text: text.slice(0, selStart) + wrapped + text.slice(selEnd),
    selStart: caret,
    selEnd: caret,
  };
}

function block(button: Extract<ToolbarButton, { kind: "block" }>, text: string, selStart: number, selEnd: number): Edit {
  const lines = text.split("\n");
  const first = lineOf(text, selStart);
  // A caret with no selection still addresses its own line — otherwise the
  // most common case (turn this line into a bullet) would need a selection.
  const last = lineOf(text, Math.max(selEnd, selStart));

  const touched = lines.slice(first, last + 1);
  const allMarked = touched.every((l) => button.match.test(l));

  const rewritten = touched.map((line, n) =>
    allMarked ? line.replace(button.match, "") : button.prefix(n) + line.replace(button.match, ""),
  );

  const next = [...lines.slice(0, first), ...rewritten, ...lines.slice(last + 1)].join("\n");
  // Reselect the affected lines: their length changed, so the old offsets are
  // meaningless and a stale selection would look like the edit went wrong.
  const from = lines.slice(0, first).join("\n").length + (first > 0 ? 1 : 0);
  return { text: next, selStart: from, selEnd: from + rewritten.join("\n").length };
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length - 1;
}

const TASK_LINE = /^(\s*[-*+] \[)([ xX])(\])/;

/** Flip one task line's box. Used by the rendered view's checkboxes. */
export function toggleTask(text: string, line: number): string {
  const lines = text.split("\n");
  const target = lines[line];
  if (target === undefined) return text;
  const match = TASK_LINE.exec(target);
  if (!match) return text;
  lines[line] = target.replace(TASK_LINE, `$1${match[2]!.toLowerCase() === "x" ? " " : "x"}$3`);
  return lines.join("\n");
}
