import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRoots, scan, type StoreRoots } from "./scan";

const tempRoot = (name: string) => mkdtempSync(join(tmpdir(), `ddd-models-${name}-`));

/** Every store pointed at a folder that does not exist. */
function emptyRoots(base: string): StoreRoots {
  return {
    ollama: join(base, "ollama"),
    huggingface: join(base, "hf"),
    lmstudio: join(base, "lmstudio"),
    llamacpp: join(base, "llamacpp"),
    jan: join(base, "jan"),
    gpt4all: join(base, "gpt4all"),
  };
}

const sha = (n: number) => n.toString(16).padStart(64, "0");

/** An Ollama store with a manifest per model; layers are `[digest, bytes]`. */
function ollamaStore(root: string, models: Record<string, Array<[string, number, string?]>>): void {
  mkdirSync(join(root, "blobs"), { recursive: true });
  for (const [name, layers] of Object.entries(models)) {
    const [repo, tag] = name.split(":");
    const dir = join(root, "manifests", "registry.ollama.ai", "library", repo!);
    mkdirSync(dir, { recursive: true });
    const manifest = {
      schemaVersion: 2,
      config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: `sha256:${sha(999)}`, size: 3 },
      layers: layers.map(([digest, size, kind]) => ({
        mediaType: `application/vnd.ollama.image.${kind ?? "model"}`,
        digest: `sha256:${digest}`,
        size,
      })),
    };
    writeFileSync(join(dir, tag ?? "latest"), JSON.stringify(manifest));
    for (const [digest, size] of layers) writeFileSync(join(root, "blobs", `sha256-${digest}`), "x".repeat(size));
  }
  writeFileSync(join(root, "blobs", `sha256-${sha(999)}`), "{}!");
}

/** A Hugging Face hub cache folder for one repo, with a snapshot of symlinked blobs. */
function hfModel(hub: string, repo: string, files: Record<string, number>): string {
  const dir = join(hub, `models--${repo.replace("/", "--")}`);
  const snap = join(dir, "snapshots", "abc123");
  mkdirSync(join(dir, "blobs"), { recursive: true });
  mkdirSync(join(dir, "refs"), { recursive: true });
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(dir, "refs", "main"), "abc123");
  let i = 0;
  for (const [file, size] of Object.entries(files)) {
    const blob = `blob${i++}`;
    writeFileSync(join(dir, "blobs", blob), "y".repeat(size));
    symlinkSync(join("..", "..", "blobs", blob), join(snap, file));
  }
  return dir;
}

describe("defaultRoots", () => {
  it("honours OLLAMA_MODELS and HF_HUB_CACHE over the platform defaults", () => {
    const r = defaultRoots({ OLLAMA_MODELS: "/x/ollama", HF_HUB_CACHE: "/x/hub" }, "/home/me", "darwin");
    expect(r.ollama).toBe("/x/ollama");
    expect(r.huggingface).toBe("/x/hub");
  });

  it("derives the hub from HF_HOME when HF_HUB_CACHE is unset", () => {
    const r = defaultRoots({ HF_HOME: "/x/hf" }, "/home/me", "linux");
    expect(r.huggingface).toBe("/x/hf/hub");
  });

  it("falls back to the well-known folders under the home directory", () => {
    const r = defaultRoots({}, "/home/me", "darwin");
    expect(r.ollama).toBe("/home/me/.ollama/models");
    expect(r.huggingface).toBe("/home/me/.cache/huggingface/hub");
    expect(r.lmstudio).toBe("/home/me/.lmstudio/models");
    expect(r.llamacpp).toBe("/home/me/Library/Caches/llama.cpp");
    expect(r.gpt4all).toBe("/home/me/Library/Application Support/nomic.ai/GPT4All");
    expect(defaultRoots({}, "/home/me", "linux").llamacpp).toBe("/home/me/.cache/llama.cpp");
  });
});

describe("scan", () => {
  it("reports a store that is missing on disk as absent, with no models", async () => {
    const roots = emptyRoots(tempRoot("absent"));
    const result = await scan(roots);
    const ollama = result.stores.find((s) => s.runtime === "ollama")!;
    expect(ollama.present).toBe(false);
    expect(ollama.models).toEqual([]);
    expect(result.totalBytes).toBe(0);
  });

  it("lists Ollama models from their manifests with the summed layer sizes", async () => {
    const roots = emptyRoots(tempRoot("ollama"));
    ollamaStore(roots.ollama, {
      "qwen3:8b": [
        [sha(1), 5000],
        [sha(2), 40, "template"],
      ],
      "llama3.2:3b": [[sha(3), 3000]],
    });
    const result = await scan(roots);
    const ollama = result.stores.find((s) => s.runtime === "ollama")!;
    expect(ollama.present).toBe(true);
    expect(ollama.models.map((m) => [m.name, m.bytes]).sort()).toEqual([
      ["llama3.2:3b", 3000],
      ["qwen3:8b", 5040],
    ]);
    expect(ollama.models.find((m) => m.name === "qwen3:8b")!.path).toBe(
      join(roots.ollama, "manifests", "registry.ollama.ai", "library", "qwen3", "8b"),
    );
    expect(ollama.bytes).toBe(8040);
    expect(result.totalBytes).toBe(8040);
  });

  it("names Ollama models from a non-library namespace with their owner", async () => {
    const roots = emptyRoots(tempRoot("ns"));
    ollamaStore(roots.ollama, { "qwen3:8b": [[sha(1), 10]] });
    const dir = join(roots.ollama, "manifests", "registry.ollama.ai", "orcarouter", "Qwen3.8-27B");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "q4_K_M"),
      JSON.stringify({
        schemaVersion: 2,
        layers: [{ mediaType: "application/vnd.ollama.image.model", digest: `sha256:${sha(7)}`, size: 12 }],
      }),
    );
    const result = await scan(roots);
    const names = result.stores
      .find((s) => s.runtime === "ollama")!
      .models.map((m) => m.name)
      .sort();
    expect(names).toEqual(["orcarouter/Qwen3.8-27B:q4_K_M", "qwen3:8b"]);
  });

  it("lists Hugging Face hub repos as org/name with the bytes of their blobs", async () => {
    const roots = emptyRoots(tempRoot("hf"));
    mkdirSync(roots.huggingface, { recursive: true });
    writeFileSync(join(roots.huggingface, "CACHEDIR.TAG"), "tag");
    const dir = hfModel(roots.huggingface, "mlx-community/whisper-large-v3-turbo", { "config.json": 100, "weights.safetensors": 9000 });
    const result = await scan(roots);
    const hf = result.stores.find((s) => s.runtime === "huggingface")!;
    expect(hf.models).toHaveLength(1);
    expect(hf.models[0]!.name).toBe("mlx-community/whisper-large-v3-turbo");
    expect(hf.models[0]!.path).toBe(dir);
    // The blobs plus the six-byte refs/main pointer: folder size is what the
    // user frees by moving it, so the metadata counts too.
    expect(hf.models[0]!.bytes).toBe(9106);
  });

  it("treats each entry of a flat store as one model, sized recursively", async () => {
    const roots = emptyRoots(tempRoot("flat"));
    mkdirSync(join(roots.llamacpp), { recursive: true });
    writeFileSync(join(roots.llamacpp, "tiny.gguf"), "z".repeat(500));
    mkdirSync(join(roots.jan, "llama-3"), { recursive: true });
    writeFileSync(join(roots.jan, "llama-3", "model.gguf"), "z".repeat(700));
    writeFileSync(join(roots.jan, "llama-3", "model.json"), "z".repeat(50));
    writeFileSync(join(roots.jan, ".DS_Store"), "junk");
    const result = await scan(roots);
    const llamacpp = result.stores.find((s) => s.runtime === "llamacpp")!;
    expect(llamacpp.models.map((m) => [m.name, m.bytes])).toEqual([["tiny.gguf", 500]]);
    const jan = result.stores.find((s) => s.runtime === "jan")!;
    expect(jan.models.map((m) => [m.name, m.bytes])).toEqual([["llama-3", 750]]);
  });

  it("lists LM Studio models one level down, as publisher/model", async () => {
    const roots = emptyRoots(tempRoot("lms"));
    mkdirSync(join(roots.lmstudio, "lmstudio-community", "Qwen2.5-7B-GGUF"), { recursive: true });
    writeFileSync(join(roots.lmstudio, "lmstudio-community", "Qwen2.5-7B-GGUF", "q4.gguf"), "z".repeat(300));
    const result = await scan(roots);
    const lms = result.stores.find((s) => s.runtime === "lmstudio")!;
    expect(lms.models.map((m) => [m.name, m.bytes])).toEqual([["lmstudio-community/Qwen2.5-7B-GGUF", 300]]);
  });

  it("gives every model a stable id of runtime and name", async () => {
    const roots = emptyRoots(tempRoot("ids"));
    ollamaStore(roots.ollama, { "qwen3:8b": [[sha(1), 10]] });
    const result = await scan(roots);
    expect(result.stores.find((s) => s.runtime === "ollama")!.models[0]!.id).toBe("ollama:qwen3:8b");
  });
});
