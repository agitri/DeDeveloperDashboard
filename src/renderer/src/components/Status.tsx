/**
 * A verdict, as a word.
 *
 * The Console system renders these as `[ ENDED ]` — the brackets come from CSS,
 * the dot is hidden, and the word carries the meaning alone. That is the brief's
 * rule made structural: colour is never the only carrier, so there is no way to
 * render one of these without saying what it is.
 *
 * `unknown` is deliberately the odd one out: lower case, unemphasised, no
 * colour. Something not checked yet must never read as a verdict.
 */
export type State = "up" | "ok" | "live" | "busy" | "warn" | "down" | "ended" | "err" | "unknown";

export function Status({ state, label, title }: { state: State; label: string; title?: string }) {
  return (
    <span className="status" data-state={state} title={title}>
      <i />
      {label}
    </span>
  );
}

/**
 * What a widget says when it has nothing to show.
 *
 * Left-aligned where the first row would be, never centred, never red, no icon:
 * "nothing is listening" is usually good news, and an empty state that looks
 * like a failure is the app crying wolf at itself.
 */
export function Empty({
  title,
  body,
  meta,
}: {
  title: string;
  body?: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {body && <div className="empty-body">{body}</div>}
      {meta && <div className="empty-meta">{meta}</div>}
    </div>
  );
}
