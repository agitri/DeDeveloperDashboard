/**
 * Physically move one model out of its runtime's store into a folder of the
 * user's choosing, so it becomes a thing you can drag to the trash.
 *
 * For every runtime but Ollama the model already is a folder or a file, so a
 * move is a move: `rename` when the destination is on the same volume, a
 * copy-verify-remove with byte progress when it is not. Ollama is different —
 * it stores content-addressed blobs shared between models and only sees what
 * is inside its own store — so "moving" an Ollama model means exporting it: the
 * GGUF plus a Modelfile that `ollama create` can re-import, then dropping the
 * manifest and every blob nothing else references.
 */
import { createReadStream, createWriteStream, promises as fsp } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { DddError } from "../error";
import { readManifest, sizeOf, type LocalModel, type StoreRoots } from "./scan";

export interface MoveProgress {
  id: string;
  phase: "copy" | "remove" | "done" | "error";
  bytesDone: number;
  bytesTotal: number;
  error?: string;
}

export type OnProgress = (p: MoveProgress) => void;

/** Seams for tests: a `rename` that fails with EXDEV forces the copy path, and
 *  `freeBytes` stands in for `statfs` on a temp dir. */
export interface MoveDeps {
  rename?: (from: string, to: string) => Promise<void>;
  freeBytes?: (dir: string) => Promise<number>;
}

export interface MoveResult {
  destination: string;
}

async function statfsFree(dir: string): Promise<number> {
  const s = await fsp.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

const isInside = (parent: string, child: string): boolean => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
};

const exists = async (p: string): Promise<boolean> => {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
};

/** The folder an Ollama model is exported into: `qwen3:8b` → `qwen3-8b`,
 *  `owner/repo:tag` → `owner--repo-tag`. Colons render as slashes in Finder
 *  and slashes are separators, so neither survives. */
export function ollamaFolderName(name: string): string {
  return name.replace(/\//g, "--").replace(/:/g, "-");
}

// ---- copying with progress ----

async function copyFile(src: string, dst: string, tick: (n: number) => void): Promise<void> {
  const reader = createReadStream(src);
  reader.on("data", (chunk) => tick(chunk.length));
  await pipeline(reader, createWriteStream(dst));
}

/** Recursive copy that keeps symlinks as symlinks (with their literal target,
 *  so the relative `../../blobs/…` links in a Hugging Face snapshot still
 *  resolve after the move) and reports every chunk of file data written. */
async function copyTree(src: string, dst: string, tick: (n: number) => void): Promise<void> {
  const st = await fsp.lstat(src);
  if (st.isSymbolicLink()) {
    await fsp.symlink(await fsp.readlink(src), dst);
    return;
  }
  if (!st.isDirectory()) {
    await copyFile(src, dst, tick);
    return;
  }
  await fsp.mkdir(dst, { recursive: true });
  for (const name of await fsp.readdir(src)) await copyTree(join(src, name), join(dst, name), tick);
}

/** Move a file or folder: rename when the volume allows it, otherwise copy,
 *  verify the byte count, and only then remove the source. */
async function relocate(
  src: string,
  dst: string,
  total: number,
  report: (phase: MoveProgress["phase"], done: number) => void,
  deps: MoveDeps,
): Promise<void> {
  await fsp.mkdir(dirname(dst), { recursive: true });
  const rename = deps.rename ?? ((a: string, b: string) => fsp.rename(a, b));
  try {
    await rename(src, dst);
    report("copy", total);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw DddError.io(e);
  }
  let done = 0;
  report("copy", 0);
  try {
    await copyTree(src, dst, (n) => {
      done += n;
      report("copy", done);
    });
  } catch (e) {
    await fsp.rm(dst, { recursive: true, force: true });
    throw DddError.io(e);
  }
  const expected = sizeOf(src);
  const copied = sizeOf(dst);
  if (copied !== expected) {
    await fsp.rm(dst, { recursive: true, force: true });
    throw DddError.io(`copy of ${src} came out at ${copied} bytes, expected ${expected}; the source was left in place`);
  }
  report("remove", total);
  await fsp.rm(src, { recursive: true, force: true });
}

/** Delete empty parent folders up to (not including) `root`. */
async function pruneEmptyParents(from: string, root: string): Promise<void> {
  let dir = dirname(from);
  while (isInside(root, dir) && resolve(dir) !== resolve(root)) {
    const left = await fsp.readdir(dir).catch(() => ["?"]);
    if (left.length > 0) return;
    await fsp.rmdir(dir).catch(() => undefined);
    dir = dirname(dir);
  }
}

// ---- Ollama export ----

const blobPath = (root: string, digest: string): string => join(root, "blobs", digest.replace(":", "-"));

/** Visit every manifest file: manifests/<registry>/<namespace>/<repo>/<tag>. */
async function eachManifest(root: string, visit: (path: string) => void): Promise<void> {
  const walk = async (dir: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      const st = await fsp.lstat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) {
        if (depth < 4) await walk(p, depth + 1);
      } else if (depth === 4) visit(p);
    }
  };
  await walk(join(root, "manifests"), 1);
}

/** Every digest referenced by any manifest still in the store. */
async function referencedDigests(root: string): Promise<Set<string>> {
  const refs = new Set<string>();
  await eachManifest(root, (path) => {
    for (const layer of readManifest(path)) refs.add(layer.digest);
  });
  return refs;
}

const quoted = (s: string): string => `"""${s}"""`;

/** The Modelfile lines for a `params` layer: one PARAMETER per value, arrays
 *  (stop sequences) spelled out one per line the way `ollama show` does. */
export function paramLines(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) out.push(`PARAMETER ${key} ${typeof v === "string" ? JSON.stringify(v) : String(v)}`);
  }
  return out;
}

async function exportOllama(
  m: LocalModel,
  root: string,
  dest: string,
  total: number,
  report: (phase: MoveProgress["phase"], done: number) => void,
  deps: MoveDeps,
): Promise<void> {
  const layers = readManifest(m.path);
  const folder = ollamaFolderName(m.name);
  const kind = (mediaType: string) => mediaType.replace("application/vnd.ollama.image.", "");
  const modelLayers = layers.filter((l) => kind(l.mediaType) === "model");
  if (modelLayers.length === 0) throw DddError.invalid(`${m.name} has no model layer to export`);

  await fsp.mkdir(dest, { recursive: true });
  let done = 0;
  const lines: string[] = [];

  // Blobs shared with another model must be copied; unshared ones may simply
  // be renamed (same volume) since they are about to be pruned anyway.
  const others = await referencedDigestsExcept(root, m.path);
  const place = async (digest: string, target: string): Promise<void> => {
    const src = blobPath(root, digest);
    if (!others.has(digest)) {
      const rename = deps.rename ?? ((a: string, b: string) => fsp.rename(a, b));
      try {
        await rename(src, target);
        done += sizeOf(target);
        report("copy", done);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw DddError.io(e);
      }
    }
    await copyFile(src, target, (n) => {
      done += n;
      report("copy", done);
    });
  };

  report("copy", 0);
  const ggufName = `${folder}.gguf`;
  const first = modelLayers[0]!;
  await place(first.digest, join(dest, ggufName));
  lines.push(`FROM ./${ggufName}`);
  for (let i = 1; i < modelLayers.length; i++) {
    const name = `${folder}-${i + 1}.gguf`;
    await place(modelLayers[i]!.digest, join(dest, name));
    lines.push(`# additional model layer: ./${name}`);
  }

  for (const layer of layers) {
    const k = kind(layer.mediaType);
    if (k === "model" || layer.mediaType.startsWith("application/vnd.docker")) continue;
    const src = blobPath(root, layer.digest);
    if (k === "adapter" || k === "projector") {
      const name = `${k}.bin`;
      await place(layer.digest, join(dest, name));
      lines.push(k === "adapter" ? `ADAPTER ./${name}` : `# projector: ./${name}`);
      continue;
    }
    const text = await fsp.readFile(src, "utf8").catch(() => null);
    if (text === null) continue;
    done += layer.size;
    report("copy", done);
    if (k === "template") lines.push(`TEMPLATE ${quoted(text)}`);
    else if (k === "system") lines.push(`SYSTEM ${quoted(text)}`);
    else if (k === "license") lines.push(`LICENSE ${quoted(text)}`);
    else if (k === "params") lines.push(...paramLines(text));
    else if (k === "messages") lines.push(`# messages layer (not exported): ${layer.digest}`);
  }
  await fsp.writeFile(
    join(dest, "Modelfile"),
    `# Exported from Ollama (${m.name}) by DDD. Re-import: ollama create ${m.name} -f Modelfile\n${lines.join("\n")}\n`,
  );

  // Now remove it from Ollama: the manifest first, then whatever the remaining
  // manifests no longer point at.
  report("remove", total);
  await fsp.rm(m.path, { force: true });
  await pruneEmptyParents(m.path, join(root, "manifests"));
  const still = await referencedDigests(root);
  for (const layer of layers) {
    if (!still.has(layer.digest)) await fsp.rm(blobPath(root, layer.digest), { force: true });
  }
}

/** Of the digests one manifest references, those that some *other* manifest
 *  references too — the blobs an export must copy rather than take. */
async function referencedDigestsExcept(root: string, manifest: string): Promise<Set<string>> {
  const mine = new Set(readManifest(manifest).map((l) => l.digest));
  const shared = new Set<string>();
  await eachManifest(root, (path) => {
    if (resolve(path) === resolve(manifest)) return;
    for (const layer of readManifest(path)) if (mine.has(layer.digest)) shared.add(layer.digest);
  });
  return shared;
}

// ---- entry point ----

export async function moveModel(
  m: LocalModel,
  roots: StoreRoots,
  destRoot: string,
  onProgress?: OnProgress,
  deps: MoveDeps = {},
): Promise<MoveResult> {
  const root = roots[m.runtime];
  if (!root || !isInside(root, m.path) || resolve(root) === resolve(m.path)) {
    throw DddError.invalid(`${m.id} is not inside its ${m.runtime} store (${root})`);
  }
  if (isInside(root, destRoot)) throw DddError.invalid(`the destination is inside the ${m.runtime} store; pick a folder outside ${root}`);
  if (!(await exists(m.path))) throw DddError.notFound(`${m.id} is no longer at ${m.path}`);

  const destination =
    m.runtime === "ollama" ? join(destRoot, "ollama", ollamaFolderName(m.name))
    : m.runtime === "huggingface" ? join(destRoot, "huggingface", relative(root, m.path))
    : join(destRoot, m.runtime, relative(root, m.path));
  if (await exists(destination)) throw DddError.invalid(`${destination} already exists; move or remove it first`);

  const total = m.runtime === "ollama" ? readManifest(m.path).reduce((n, l) => n + l.size, 0) : sizeOf(m.path);
  await fsp.mkdir(destRoot, { recursive: true });
  const free = await (deps.freeBytes ?? statfsFree)(destRoot);
  // A rename needs no space, but we cannot know in advance whether the
  // volumes match, and refusing early beats a half-copied 27 GB folder.
  if (free < total) {
    throw DddError.config(`not enough free space at ${destRoot}: ${m.name} needs ${total} bytes, ${free} available`);
  }

  const report = (phase: MoveProgress["phase"], bytesDone: number) =>
    onProgress?.({ id: m.id, phase, bytesDone: Math.min(bytesDone, total), bytesTotal: total });
  try {
    if (m.runtime === "ollama") await exportOllama(m, root, destination, total, report, deps);
    else {
      await relocate(m.path, destination, total, report, deps);
      await pruneEmptyParents(m.path, root);
    }
  } catch (e) {
    onProgress?.({ id: m.id, phase: "error", bytesDone: 0, bytesTotal: total, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  report("done", total);
  return { destination };
}
