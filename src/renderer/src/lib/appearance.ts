import type { HintSize } from "../types";

/**
 * Preset palettes. One definition serves both looks: classic reads its
 * `--ink` family and console its `--text` family, so `schemeVars` maps the
 * same twelve values onto whichever token names the running look uses. The
 * accent is deliberately not part of a scheme — it is the environment colour.
 */
export interface Palette {
  bg: string;
  surface: string;
  /** Cards/raised panels (classic `--raised`, console `--surface-2`). */
  surface2: string;
  /** Inset areas (classic `--sunken`). */
  sunken: string;
  text: string;
  text2: string;
  text3: string;
  line: string;
  lineStrong: string;
  ok: string;
  warn: string;
  err: string;
}

export interface Scheme {
  id: string;
  name: string;
  /** Absent on "default": the stylesheet's own palette is left alone. */
  light?: Palette;
  dark?: Palette;
}

export const SCHEMES: Scheme[] = [
  { id: "default", name: "Default" },
  {
    id: "nord",
    name: "Nord",
    light: {
      bg: "#eceff4",
      surface: "#ffffff",
      surface2: "#f5f7fa",
      sunken: "#e5e9f0",
      text: "#2e3440",
      text2: "#4c566a",
      text3: "#7b88a1",
      line: "#d8dee9",
      lineStrong: "#b8c2d6",
      ok: "#4c8a2f",
      warn: "#a07a1a",
      err: "#bf616a",
    },
    dark: {
      bg: "#2e3440",
      surface: "#3b4252",
      surface2: "#434c5e",
      sunken: "#272c36",
      text: "#eceff4",
      text2: "#d8dee9",
      text3: "#9aa5b8",
      line: "#434c5e",
      lineStrong: "#4c566a",
      ok: "#a3be8c",
      warn: "#ebcb8b",
      err: "#bf616a",
    },
  },
  {
    id: "solarized",
    name: "Solarized",
    light: {
      bg: "#fdf6e3",
      surface: "#fffdf5",
      surface2: "#f7efd9",
      sunken: "#eee8d5",
      text: "#073642",
      text2: "#586e75",
      text3: "#93a1a1",
      line: "#e5dcc0",
      lineStrong: "#cfc4a0",
      ok: "#6c8a00",
      warn: "#946e00",
      err: "#dc322f",
    },
    dark: {
      bg: "#002b36",
      surface: "#073642",
      surface2: "#0b4350",
      sunken: "#00222c",
      text: "#eee8d5",
      text2: "#93a1a1",
      text3: "#657b83",
      line: "#0f4b5a",
      lineStrong: "#1f5f6e",
      ok: "#859900",
      warn: "#b58900",
      err: "#dc322f",
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    light: {
      bg: "#fbf1c7",
      surface: "#fffaea",
      surface2: "#f2e5bc",
      sunken: "#ebdbb2",
      text: "#3c3836",
      text2: "#504945",
      text3: "#7c6f64",
      line: "#e3d6a8",
      lineStrong: "#d5c4a1",
      ok: "#79740e",
      warn: "#b57614",
      err: "#cc241d",
    },
    dark: {
      bg: "#282828",
      surface: "#32302f",
      surface2: "#3c3836",
      sunken: "#1d2021",
      text: "#ebdbb2",
      text2: "#d5c4a1",
      text3: "#a89984",
      line: "#3c3836",
      lineStrong: "#504945",
      ok: "#b8bb26",
      warn: "#fabd2f",
      err: "#fb4934",
    },
  },
  {
    id: "paper",
    name: "Warm paper",
    light: {
      bg: "#f7f3ea",
      surface: "#fffdf8",
      surface2: "#fbf8f0",
      sunken: "#efe9dc",
      text: "#2b2620",
      text2: "#5c554b",
      text3: "#948b7e",
      line: "#e4dccb",
      lineStrong: "#cdc3ad",
      ok: "#3f7d3a",
      warn: "#9b6b0a",
      err: "#c0392b",
    },
    dark: {
      bg: "#1d1a16",
      surface: "#262219",
      surface2: "#2e2a21",
      sunken: "#15130f",
      text: "#ece4d6",
      text2: "#b8ae9c",
      text3: "#7e7566",
      line: "#332e25",
      lineStrong: "#4a4336",
      ok: "#8fbf6a",
      warn: "#d8a84a",
      err: "#e06553",
    },
  },
  {
    id: "mono",
    name: "Mono",
    light: {
      bg: "#f4f4f4",
      surface: "#ffffff",
      surface2: "#fafafa",
      sunken: "#ebebeb",
      text: "#111111",
      text2: "#444444",
      text3: "#888888",
      line: "#dcdcdc",
      lineStrong: "#bdbdbd",
      ok: "#2a7a2a",
      warn: "#8a6a00",
      err: "#c62828",
    },
    dark: {
      bg: "#0f0f0f",
      surface: "#171717",
      surface2: "#1e1e1e",
      sunken: "#080808",
      text: "#ededed",
      text2: "#a8a8a8",
      text3: "#6e6e6e",
      line: "#262626",
      lineStrong: "#3a3a3a",
      ok: "#58b858",
      warn: "#d2a62c",
      err: "#e5534b",
    },
  },
];

/** The custom properties to set on <html> for a scheme, in the running look's
 *  vocabulary. Empty for "default" (and for an unknown id), which means the
 *  caller should *remove* the properties it set before. */
export function schemeVars(id: string, theme: "light" | "dark", look: "classic" | "console"): Record<string, string> {
  const scheme = SCHEMES.find((s) => s.id === id);
  const p = scheme?.[theme];
  if (!p) return {};
  const shared = { "--bg": p.bg, "--surface": p.surface, "--ok": p.ok, "--warn": p.warn, "--err": p.err };
  if (look === "console") {
    return { ...shared, "--surface-2": p.surface2, "--text": p.text, "--text-2": p.text2, "--text-3": p.text3 };
  }
  return {
    ...shared,
    "--raised": p.surface2,
    "--sunken": p.sunken,
    "--line": p.line,
    "--line-strong": p.lineStrong,
    "--ink": p.text,
    "--ink-2": p.text2,
    "--ink-3": p.text3,
  };
}

/** Every property `schemeVars` can ever set, for clearing before a re-apply. */
export const SCHEME_PROPERTIES = [
  "--bg",
  "--surface",
  "--ok",
  "--warn",
  "--err",
  "--surface-2",
  "--text",
  "--text-2",
  "--text-3",
  "--raised",
  "--sunken",
  "--line",
  "--line-strong",
  "--ink",
  "--ink-2",
  "--ink-3",
];

export const SCALE_MIN = 0.8;
export const SCALE_MAX = 1.5;

/** 0.8..1.5 in whole percents; anything unusable is 1. Twin of core's clampUiScale. */
export function clampScale(n: number): number {
  if (!Number.isFinite(n)) return 1;
  const stepped = Math.round(n * 100) / 100;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, stepped));
}

export const HINT_SIZES: HintSize[] = ["small", "medium", "large"];

export function hintAttr(size: string | undefined): HintSize {
  return (HINT_SIZES as string[]).includes(size ?? "") ? (size as HintSize) : "medium";
}
