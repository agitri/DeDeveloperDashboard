import { splitBinding } from "../keyboard/keys";

/** A shortcut badge. Modifier glyphs get their own span (`.kbd-mod`) so the
 *  stylesheet can draw ⌘⇧⌥⌃ with a font that has them at full size. */
export function Kbd({ binding, className }: { binding: string; className?: string }) {
  const { mods, key } = splitBinding(binding);
  return (
    <kbd className={className ? `kbd ${className}` : "kbd"}>
      {mods !== "" && <span className="kbd-mod">{mods}</span>}
      {key}
    </kbd>
  );
}
