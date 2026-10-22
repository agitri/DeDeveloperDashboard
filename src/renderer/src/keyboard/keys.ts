// Binding strings are written the way a person would type them — `mod+k`,
// `shift+/`, `g t` — because keymap.json is meant to be hand-edited.
//
// `mod` means ⌘ on macOS and Ctrl everywhere else, so a shipped preset works on
// every platform without forking the file.

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const MOD_ORDER = ["mod", "ctrl", "alt", "shift"] as const;

/** Canonical form of a KeyboardEvent, e.g. `mod+shift+k`. */
export function eventToBinding(e: KeyboardEvent): string {
  const parts: string[] = [];
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (mod) parts.push("mod");
  // A non-mod Ctrl on macOS is its own modifier and worth binding separately.
  if (IS_MAC && e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");

  let key = e.key;
  if (key === " ") key = "space";
  else if (key.length === 1) key = key.toLowerCase();
  else key = key.toLowerCase();
  parts.push(key);
  return parts.join("+");
}

/** Normalizes what a human wrote in keymap.json into the canonical form. */
export function normalizeBinding(binding: string): string {
  const parts = binding
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const key = parts.pop() ?? "";
  const mods = MOD_ORDER.filter((m) => parts.includes(m));
  // `cmd`/`meta`/`command` are all spellings of the same intent.
  if (parts.some((p) => ["cmd", "meta", "command", "super"].includes(p)) && !mods.includes("mod")) {
    mods.unshift("mod");
  }
  return [...mods, key].join("+");
}

const GLYPHS: Record<string, string> = {
  mod: IS_MAC ? "⌘" : "Ctrl",
  ctrl: IS_MAC ? "⌃" : "Ctrl",
  alt: IS_MAC ? "⌥" : "Alt",
  shift: IS_MAC ? "⇧" : "Shift",
  enter: "↩",
  escape: "Esc",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  space: "Space",
  tab: "⇥",
  backspace: "⌫",
};

/** What the hint chips and the palette show. */
export function formatBinding(binding: string): string {
  const { mods, key } = splitBinding(binding);
  return mods + key;
}

/** The badge's two parts: the modifier glyphs (with their joiner) and the key
 *  label. Kept apart so the `Kbd` component can give ⌘⇧⌥ a font that draws
 *  them at full size — the mono fonts lack those glyphs and the fallback
 *  renders them visibly smaller than the key next to them. */
export function splitBinding(binding: string): { mods: string; key: string } {
  const parts = normalizeBinding(binding).split("+");
  const key = parts.pop() ?? "";
  const mods = parts.map((p) => GLYPHS[p] ?? p);
  const label = GLYPHS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  if (mods.length === 0) return { mods: "", key: label };
  return IS_MAC ? { mods: mods.join(""), key: label } : { mods: mods.join("+") + "+", key: label };
}

/** True when the event came from somewhere the user is typing prose. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable === true
  );
}
