/**
 * A small, total markdown parser.
 *
 * Hand-rolled and dependency-free, producing a typed tree that the widget maps
 * to React elements. Notes live in `layout.json`, which the PRD calls readable,
 * diffable and *shareable* — so someone else's notes are untrusted input
 * arriving inside a webview that can reach IPC. Rendering to elements means
 * there is no HTML injection surface to sanitise correctly, rather than one
 * that has to stay sanitised correctly for ever.
 *
 * The catalog below is fixed rather than "whatever we felt like": the notes
 * toolbar is user-customisable, so a button that can be *added* later must
 * already parse today, or the user gets a button that writes gibberish.
 *
 * Not supported, on purpose: tables, images, footnotes, and raw HTML. HTML
 * renders as the literal text it is — that is the security property, not a gap.
 *
 * Every function here is total. Malformed input degrades to text; nothing throws.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "bold"; kids: Inline[] }
  | { t: "italic"; kids: Inline[] }
  | { t: "strike"; kids: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; kids: Inline[] };

export type ListItem = {
  kids: Inline[];
  /**
   * Set for `- [ ]` / `- [x]` items. `line` is the index in the source, which
   * is what lets a click on the rendered checkbox rewrite the right line.
   */
  task: { checked: boolean; line: number } | null;
};

export type Block =
  | { t: "heading"; level: number; kids: Inline[] }
  | { t: "para"; kids: Inline[] }
  | { t: "quote"; kids: Inline[] }
  | { t: "code"; lang: string | null; v: string }
  | { t: "rule" }
  | { t: "list"; ordered: boolean; items: ListItem[] };

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^(-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const FENCE = /^```\s*(\S*)\s*$/;
const QUOTE = /^>\s?(.*)$/;

export function parse(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const close = lines.findIndex((l, n) => n > i && /^```\s*$/.test(l));
      // An unclosed fence is a typo, not a licence to swallow the rest of the
      // note into a code block the user cannot see out of.
      if (close !== -1) {
        blocks.push({
          t: "code",
          lang: fence[1] ? fence[1] : null,
          v: lines.slice(i + 1, close).join("\n"),
        });
        i = close + 1;
        continue;
      }
    }

    if (RULE.test(line)) {
      blocks.push({ t: "rule" });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: "heading", level: heading[1]!.length, kids: inline(heading[2]!) });
      i++;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const parts: string[] = [];
      while (i < lines.length) {
        const more = QUOTE.exec(lines[i]!);
        if (!more) break;
        parts.push(more[1]!);
        i++;
      }
      blocks.push({ t: "quote", kids: inline(parts.join(" ")) });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const match = ordered ? ORDERED.exec(lines[i]!) : BULLET.exec(lines[i]!);
        if (!match) break;
        const task = TASK.exec(match[1]!);
        items.push(
          task
            ? { kids: inline(task[2]!), task: { checked: task[1]!.toLowerCase() === "x", line: i } }
            : { kids: inline(match[1]!), task: null },
        );
        i++;
      }
      blocks.push({ t: "list", ordered, items });
      continue;
    }

    // Paragraph: consecutive lines that start nothing else.
    const parts: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (
        l.trim() === "" ||
        RULE.test(l) ||
        HEADING.test(l) ||
        QUOTE.test(l) ||
        BULLET.test(l) ||
        ORDERED.test(l)
      ) {
        break;
      }
      parts.push(l.trim());
      i++;
    }
    blocks.push({ t: "para", kids: inline(parts.join(" ")) });
  }

  return blocks;
}

/**
 * Only schemes that cannot execute.
 *
 * Rendering to React elements removes the innerHTML surface, but an `href` is
 * still live: `javascript:` in a link would run on click. A rejected link
 * degrades to the literal source text so nothing is silently dropped.
 */
function safeHref(href: string): boolean {
  const trimmed = href.trim().toLowerCase();
  if (/^(https?:|mailto:)/.test(trimmed)) return true;
  // Relative and anchor links cannot carry a scheme, so they are safe too.
  return !trimmed.includes(":");
}

const MARKS: { open: string; close: string; t: "bold" | "italic" | "strike" }[] = [
  // Longest first: `**` must win over `*`, or bold parses as two empty italics.
  { open: "**", close: "**", t: "bold" },
  { open: "__", close: "__", t: "bold" },
  { open: "~~", close: "~~", t: "strike" },
  { open: "*", close: "*", t: "italic" },
  { open: "_", close: "_", t: "italic" },
];

function inline(source: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  let i = 0;

  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };

  while (i < source.length) {
    // Code first and unconditionally: nothing nests inside a code span, which
    // is the whole point of one.
    if (source[i] === "`") {
      const end = source.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        out.push({ t: "code", v: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (source[i] === "[") {
      const close = source.indexOf("](", i);
      const end = close === -1 ? -1 : source.indexOf(")", close + 2);
      if (close !== -1 && end !== -1) {
        const href = source.slice(close + 2, end);
        if (safeHref(href)) {
          flush();
          out.push({ t: "link", href, kids: inline(source.slice(i + 1, close)) });
          i = end + 1;
          continue;
        }
      }
    }

    const mark = MARKS.find((m) => source.startsWith(m.open, i));
    if (mark) {
      const end = source.indexOf(mark.close, i + mark.open.length);
      if (end !== -1 && end > i + mark.open.length) {
        flush();
        out.push({ t: mark.t, kids: inline(source.slice(i + mark.open.length, end)) });
        i = end + mark.close.length;
        continue;
      }
    }

    // Anything unmatched is just a character. This is what makes the parser
    // total: there is no failure branch, only literal text.
    text += source[i];
    i++;
  }

  flush();
  return out;
}
