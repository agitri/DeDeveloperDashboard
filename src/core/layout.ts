/**
 * `layout.json` per environment, and the two narrow file commands behind
 * "export / import layout". The webview picks the path through a dialog and
 * hands it here; this will only ever write UTF-8 to a `.json` file.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { DddError } from "./error";
import type { EnvRoot } from "./paths";
import { readJson, writeJson } from "./store";
import { defaultLayout, layoutFromJson, type Layout } from "./models";

export function layoutLoad(env: EnvRoot): Layout {
  return readJson(env.layoutFile(), layoutFromJson, defaultLayout);
}

export function layoutSave(env: EnvRoot, layout: Layout): void {
  writeJson(env.layoutFile(), layout);
}

export function layoutFileWrite(path: string, contents: string): void {
  if (extname(path) !== ".json") {
    throw DddError.invalid("a layout is written as a .json file");
  }
  try {
    writeFileSync(path, contents);
  } catch (e) {
    throw DddError.io(e);
  }
}

/** Same narrowness, and a size cap: a layout is kilobytes. */
export function layoutFileRead(path: string): string {
  const MAX = 4 * 1024 * 1024;
  if (extname(path) !== ".json") {
    throw DddError.invalid("a layout is read from a .json file");
  }
  let size: number;
  try {
    size = statSync(path).size;
  } catch (e) {
    throw DddError.io(e);
  }
  if (size > MAX) {
    throw DddError.invalid(`that file is ${size} bytes — a layout is kilobytes, so this is not one`);
  }
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw DddError.io(e);
  }
}
