/**
 * Where the local-model runtimes keep what they downloaded, and what is in
 * there. Plain filesystem reads, nothing shells out: a store that is missing
 * is an absent store, not an error, so the widget renders the ones that are
 * present. Every store's root can be overridden the way its runtime allows
 * (`OLLAMA_MODELS`, `HF_HOME`/`HF_HUB_CACHE`); the rest are well-known paths.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Runtime = "ollama" | "huggingface" | "lmstudio" | "llamacpp" | "jan" | "gpt4all";

export const RUNTIME_LABEL: Record<Runtime, string> = {
  ollama: "Ollama",
  huggingface: "Hugging Face hub (MLX, vLLM, transformers)",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
  jan: "Jan",
  gpt4all: "GPT4All",
};

export type StoreRoots = Record<Runtime, string>;

export interface LocalModel {
  /** `${runtime}:${name}` — stable across scans, what the move command is given. */
  id: string;
  runtime: Runtime;
  /** As the runtime names it: `qwen3:8b`, `mlx-community/whisper-large-v3-turbo`. */
  name: string;
  /** The manifest file (Ollama) or the folder/file that *is* the model. */
  path: string;
  bytes: number;
}

export interface ModelStore {
  runtime: Runtime;
  label: string;
  root: string;
  present: boolean;
  models: LocalModel[];
  bytes: number;
}

export interface ModelScan {
  stores: ModelStore[];
  totalBytes: number;
}

export function defaultRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): StoreRoots {
  const mac = platform === "darwin";
  const hfHome = env.HF_HOME && env.HF_HOME !== "" ? env.HF_HOME : join(home, ".cache", "huggingface");
  return {
    ollama: env.OLLAMA_MODELS && env.OLLAMA_MODELS !== "" ? env.OLLAMA_MODELS : join(home, ".ollama", "models"),
    huggingface: env.HF_HUB_CACHE && env.HF_HUB_CACHE !== "" ? env.HF_HUB_CACHE : join(hfHome, "hub"),
    lmstudio: join(home, ".lmstudio", "models"),
    llamacpp: mac ? join(home, "Library", "Caches", "llama.cpp") : join(home, ".cache", "llama.cpp"),
    jan:
      mac ? join(home, "Library", "Application Support", "Jan", "data", "models") : join(home, ".local", "share", "Jan", "data", "models"),
    gpt4all:
      mac ? join(home, "Library", "Application Support", "nomic.ai", "GPT4All") : join(home, ".local", "share", "nomic.ai", "GPT4All"),
  };
}

// ---- helpers ----

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const entries = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
};

/** Bytes of a file, or of everything under a folder. Symlinks count as their
 *  own (tiny) size, not their target's — a Hugging Face snapshot is links into
 *  the repo's own `blobs/`, and counting both would double every model. */
export function sizeOf(path: string): number {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of entries(path)) total += sizeOf(join(path, name));
  return total;
}

const model = (runtime: Runtime, name: string, path: string, bytes: number): LocalModel => ({
  id: `${runtime}:${name}`,
  runtime,
  name,
  path,
  bytes,
});

// ---- Ollama: manifests/<registry>/<namespace>/<repo>/<tag> ----

interface OllamaLayer {
  mediaType: string;
  digest: string;
  size: number;
}

export function readManifest(path: string): OllamaLayer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const layers = (parsed as { layers?: unknown }).layers;
  const config = (parsed as { config?: unknown }).config;
  const all: unknown[] = [...(Array.isArray(layers) ? (layers as unknown[]) : []), ...(config ? [config] : [])];
  return all
    .filter((l): l is OllamaLayer => typeof l === "object" && l !== null && typeof (l as OllamaLayer).digest === "string")
    .map((l) => ({ mediaType: String(l.mediaType ?? ""), digest: l.digest, size: Number(l.size ?? 0) || 0 }));
}

/** The manifest's model name: `library/` is the implicit namespace, any other
 *  namespace is spelled out, and the tag always follows a colon. */
export function ollamaName(namespace: string, repo: string, tag: string): string {
  return `${namespace === "library" ? "" : `${namespace}/`}${repo}:${tag}`;
}

function scanOllama(root: string): LocalModel[] {
  const found: LocalModel[] = [];
  const manifests = join(root, "manifests");
  for (const registry of entries(manifests)) {
    const regDir = join(manifests, registry);
    if (!isDir(regDir)) continue;
    for (const namespace of entries(regDir)) {
      const nsDir = join(regDir, namespace);
      if (!isDir(nsDir)) continue;
      for (const repo of entries(nsDir)) {
        const repoDir = join(nsDir, repo);
        if (!isDir(repoDir)) continue;
        for (const tag of entries(repoDir)) {
          const path = join(repoDir, tag);
          if (isDir(path)) continue;
          const layers = readManifest(path);
          if (layers.length === 0) continue;
          // The config blob is a few hundred bytes of metadata; the model is
          // its layers. Summing only layers is what `ollama list` shows.
          const bytes = layers
            .filter((l) => l.mediaType !== "application/vnd.docker.container.image.v1+json")
            .reduce((n, l) => n + l.size, 0);
          found.push(model("ollama", ollamaName(namespace, repo, tag), path, bytes));
        }
      }
    }
  }
  return found;
}

// ---- Hugging Face hub: models--<org>--<name>/{blobs,refs,snapshots} ----

function scanHub(root: string): LocalModel[] {
  const found: LocalModel[] = [];
  for (const name of entries(root)) {
    if (!name.startsWith("models--")) continue;
    const path = join(root, name);
    if (!isDir(path)) continue;
    const repo = name.slice("models--".length).replace("--", "/");
    found.push(model("huggingface", repo, path, sizeOf(path)));
  }
  return found;
}

// ---- flat stores: every entry is a model; LM Studio nests publisher/model ----

function scanFlat(runtime: Runtime, root: string, depth: 1 | 2): LocalModel[] {
  const found: LocalModel[] = [];
  for (const first of entries(root)) {
    const p1 = join(root, first);
    if (depth === 1 || !isDir(p1)) {
      found.push(model(runtime, first, p1, sizeOf(p1)));
      continue;
    }
    for (const second of entries(p1)) {
      const p2 = join(p1, second);
      found.push(model(runtime, `${first}/${second}`, p2, sizeOf(p2)));
    }
  }
  return found;
}

// ---- dispatch ----

const SCANNERS: Record<Runtime, (root: string) => LocalModel[]> = {
  ollama: scanOllama,
  huggingface: scanHub,
  lmstudio: (root) => scanFlat("lmstudio", root, 2),
  llamacpp: (root) => scanFlat("llamacpp", root, 1),
  jan: (root) => scanFlat("jan", root, 1),
  gpt4all: (root) => scanFlat("gpt4all", root, 1),
};

export const RUNTIMES = Object.keys(SCANNERS) as Runtime[];

export async function scan(roots: StoreRoots = defaultRoots()): Promise<ModelScan> {
  const stores: ModelStore[] = RUNTIMES.map((runtime) => {
    const root = roots[runtime];
    const present = isDir(root);
    const models = present ? SCANNERS[runtime](root) : [];
    models.sort((a, b) => b.bytes - a.bytes);
    return { runtime, label: RUNTIME_LABEL[runtime], root, present, models, bytes: models.reduce((n, m) => n + m.bytes, 0) };
  });
  return { stores, totalBytes: stores.reduce((n, s) => n + s.bytes, 0) };
}
