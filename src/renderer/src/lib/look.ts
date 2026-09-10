/**
 * Which visual system is running, decided once at boot.
 *
 * Read from localStorage rather than from the `data-look` attribute, and that
 * is not a detail: ES module imports are evaluated before the importing
 * module's body runs, so anything reading the DOM here would run *before*
 * `main.tsx` had set the attribute, and every component would branch classic
 * while the stylesheet went Console. It did exactly that once.
 *
 * A look change is a reload, which is what makes it safe to treat as a
 * constant for the life of the window.
 */
function chosen(): "console" | "classic" {
  // A URL parameter still wins, because a browser preview has an address bar
  // and the desktop window does not — which is exactly why it cannot be the
  // only way in. Settings → Appearance is.
  const fromUrl = new URLSearchParams(location.search).get("look");
  if (fromUrl === "console" || fromUrl === "classic") {
    localStorage.setItem("ddd:look", fromUrl);
    return fromUrl;
  }
  return localStorage.getItem("ddd:look") === "console" ? "console" : "classic";
}

/**
 * Keep the boot-time cache in step with the saved setting.
 *
 * Settings arrive over async IPC, long after the look has had to be decided,
 * so `global.json` is the source of truth and localStorage is how the next
 * window load learns about it. Returns true when the two disagreed, which is
 * the caller's cue that a reload would change what is on screen.
 */
export function rememberLook(look: string | undefined): boolean {
  // No setting is not the same as a setting of "classic". A `global.json`
  // written before this field existed has nothing to say, and treating its
  // silence as a choice would flip anyone who picked Console with `?look=`
  // straight back — and pop a "look changed" toast at them for good measure.
  if (look !== "console" && look !== "classic") return false;
  const wanted = look;
  if (localStorage.getItem("ddd:look") === wanted) return false;
  localStorage.setItem("ddd:look", wanted);
  return wanted !== LOOK;
}

export const LOOK = chosen();
export const isConsole = LOOK === "console";

/** A tab's three-letter code, for the collapsed rail. */
export function tabCode(name: string): string {
  const letters = name.replace(/[^a-zA-Z0-9]/g, "");
  return (letters.slice(0, 3) || name.slice(0, 3)).toUpperCase();
}
