import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { moveModel, ollamaFolderName, type MoveProgress } from "./move";
import { scan, type LocalModel, type StoreRoots } from "./scan";

const tempRoot = (name: string) => mkdtempSync(join(tmpdir(), `ddd-move-${name}-`));

function roots(base: string): StoreRoots {
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

function ollamaStore(root: string, models: Record<string, Array<[string, number, string?]>>): void {
  mkdirSync(join(root, "blobs"), { recursive: true });
  for (const [name, layers] of Object.entries(models)) {
    const [repo, tag] = name.split(":");
    const dir = join(root, "manifests", "registry.ollama.ai", "library", repo!);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, tag ?? "latest"),
      JSON.stringify({
        schemaVersion: 2,
        config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: `sha256:${sha(999)}`, size: 2 },
        layers: layers.map(([digest, size, kind]) => ({
          mediaType: `application/vnd.ollama.image.${kind ?? "model"}`,
          digest: `sha256:${digest}`,
          size,
        })),
      }),
    );
    for (const [digest, size] of layers) writeFileSync(join(root, "blobs", `sha256-${digest}`), "x".repeat(size));
  }
  writeFileSync(join(root, "blobs", `sha256-${sha(999)}`), "{}");
}

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

async function find(r: StoreRoots, id: string): Promise<LocalModel> {
  const result = await scan(r);
  const m = result.stores.flatMap((s) => s.models).find((x) => x.id === id);
  if (!m) throw new Error(`fixture has no ${id}`);
  return m;
}

const exdev = async () => {
  const e = new Error("cross-device link") as NodeJS.ErrnoException;
  e.code = "EXDEV";
  throw e;
};
const plenty = async () => Number.MAX_SAFE_INTEGER;

describe("moveModel — folders and files", () => {
  it("moves a Hugging Face repo folder under <dest>/huggingface keeping its snapshot links", async () => {
    const base = tempRoot("hf");
    const r = roots(base);
    hfModel(r.huggingface, "mlx-community/whisper", { "config.json": 10, "weights.safetensors": 500 });
    const dest = join(base, "dest");
    const m = await find(r, "huggingface:mlx-community/whisper");

    const out = await moveModel(m, r, dest, undefined, { freeBytes: plenty });

    expect(out.destination).toBe(join(dest, "huggingface", "models--mlx-community--whisper"));
    expect(existsSync(m.path)).toBe(false);
    const link = join(out.destination, "snapshots", "abc123", "weights.safetensors");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(link, "utf8")).toBe("y".repeat(500));
  });

  it("copies then removes when the destination is on another volume, reporting byte progress", async () => {
    const base = tempRoot("xdev");
    const r = roots(base);
    hfModel(r.huggingface, "org/big", { "a.bin": 300, "b.bin": 200 });
    const dest = join(base, "dest");
    const m = await find(r, "huggingface:org/big");
    const seen: MoveProgress[] = [];

    const out = await moveModel(m, r, dest, (p) => seen.push(p), { rename: exdev, freeBytes: plenty });

    expect(existsSync(m.path)).toBe(false);
    expect(readFileSync(join(out.destination, "blobs", "blob0"), "utf8")).toBe("y".repeat(300));
    expect(readlinkSync(join(out.destination, "snapshots", "abc123", "a.bin"))).toBe(join("..", "..", "blobs", "blob0"));
    const copies = seen.filter((p) => p.phase === "copy");
    expect(copies.length).toBeGreaterThan(0);
    for (let i = 1; i < copies.length; i++) expect(copies[i]!.bytesDone).toBeGreaterThanOrEqual(copies[i - 1]!.bytesDone);
    expect(seen.at(-1)).toMatchObject({ id: m.id, phase: "done", bytesDone: m.bytes, bytesTotal: m.bytes });
  });

  it("moves a single-file model and an LM Studio publisher/model folder", async () => {
    const base = tempRoot("flat");
    const r = roots(base);
    mkdirSync(r.llamacpp, { recursive: true });
    writeFileSync(join(r.llamacpp, "tiny.gguf"), "z".repeat(50));
    mkdirSync(join(r.lmstudio, "pub", "Model-GGUF"), { recursive: true });
    writeFileSync(join(r.lmstudio, "pub", "Model-GGUF", "q4.gguf"), "z".repeat(60));
    const dest = join(base, "dest");

    const a = await moveModel(await find(r, "llamacpp:tiny.gguf"), r, dest, undefined, { freeBytes: plenty });
    const b = await moveModel(await find(r, "lmstudio:pub/Model-GGUF"), r, dest, undefined, { freeBytes: plenty });

    expect(a.destination).toBe(join(dest, "llamacpp", "tiny.gguf"));
    expect(readFileSync(a.destination, "utf8")).toBe("z".repeat(50));
    expect(b.destination).toBe(join(dest, "lmstudio", "pub", "Model-GGUF"));
    expect(readFileSync(join(b.destination, "q4.gguf"), "utf8")).toBe("z".repeat(60));
    // The now-empty publisher folder does not linger in the store.
    expect(existsSync(join(r.lmstudio, "pub"))).toBe(false);
  });
});

describe("moveModel — refusals", () => {
  it("refuses when the destination already exists, leaving the source untouched", async () => {
    const base = tempRoot("exists");
    const r = roots(base);
    hfModel(r.huggingface, "org/dup", { "a.bin": 10 });
    const dest = join(base, "dest");
    mkdirSync(join(dest, "huggingface", "models--org--dup"), { recursive: true });
    const m = await find(r, "huggingface:org/dup");

    await expect(moveModel(m, r, dest, undefined, { freeBytes: plenty })).rejects.toThrow(/already exists/);
    expect(existsSync(m.path)).toBe(true);
  });

  it("refuses when the destination lacks free space, before writing anything", async () => {
    const base = tempRoot("space");
    const r = roots(base);
    hfModel(r.huggingface, "org/large", { "a.bin": 1000 });
    const dest = join(base, "dest");
    const m = await find(r, "huggingface:org/large");

    await expect(moveModel(m, r, dest, undefined, { freeBytes: async () => 10 })).rejects.toThrow(/free space/);
    expect(existsSync(m.path)).toBe(true);
    expect(existsSync(join(dest, "huggingface"))).toBe(false);
  });

  it("refuses a destination inside the store it is moving out of", async () => {
    const base = tempRoot("inside");
    const r = roots(base);
    hfModel(r.huggingface, "org/loop", { "a.bin": 10 });
    const m = await find(r, "huggingface:org/loop");

    await expect(moveModel(m, r, join(r.huggingface, "archive"), undefined, { freeBytes: plenty })).rejects.toThrow(/inside/);
  });

  it("refuses a model whose path is not under its own store root", async () => {
    const base = tempRoot("forged");
    const r = roots(base);
    const forged: LocalModel = { id: "llamacpp:etc", runtime: "llamacpp", name: "etc", path: join(base, "elsewhere"), bytes: 1 };
    await expect(moveModel(forged, r, join(base, "dest"), undefined, { freeBytes: plenty })).rejects.toThrow(/not inside/);
  });
});

describe("moveModel — Ollama export", () => {
  it("names the export folder after the model without colons or slashes", () => {
    expect(ollamaFolderName("qwen3:8b")).toBe("qwen3-8b");
    expect(ollamaFolderName("orcarouter/Qwen3.8-27B:q4_K_M")).toBe("orcarouter--Qwen3.8-27B-q4_K_M");
  });

  it("writes the GGUF and a Modelfile, then drops the manifest and its unshared blobs", async () => {
    const base = tempRoot("ollama");
    const r = roots(base);
    ollamaStore(r.ollama, {
      "qwen3:8b": [
        [sha(1), 500],
        [sha(2), 30, "template"],
        [sha(3), 20, "system"],
        [sha(4), 40, "params"],
        [sha(5), 15, "license"],
      ],
      "qwen3:4b": [
        [sha(6), 300],
        [sha(2), 30, "template"],
      ],
    });
    writeFileSync(join(r.ollama, "blobs", `sha256-${sha(2)}`), "{{ .Prompt }}");
    writeFileSync(join(r.ollama, "blobs", `sha256-${sha(3)}`), "Be brief.");
    writeFileSync(join(r.ollama, "blobs", `sha256-${sha(4)}`), JSON.stringify({ temperature: 0.7, stop: ["<a>", "<b>"] }));
    writeFileSync(join(r.ollama, "blobs", `sha256-${sha(5)}`), "MIT");
    const dest = join(base, "dest");
    const m = await find(r, "ollama:qwen3:8b");

    const out = await moveModel(m, r, dest, undefined, { freeBytes: plenty });

    expect(out.destination).toBe(join(dest, "ollama", "qwen3-8b"));
    expect(readFileSync(join(out.destination, "qwen3-8b.gguf"), "utf8")).toBe("x".repeat(500));
    const modelfile = readFileSync(join(out.destination, "Modelfile"), "utf8");
    expect(modelfile).toContain("FROM ./qwen3-8b.gguf");
    expect(modelfile).toContain('TEMPLATE """{{ .Prompt }}"""');
    expect(modelfile).toContain('SYSTEM """Be brief."""');
    expect(modelfile).toContain("PARAMETER temperature 0.7");
    expect(modelfile).toContain('PARAMETER stop "<a>"');
    expect(modelfile).toContain('PARAMETER stop "<b>"');
    expect(modelfile).toContain('LICENSE """MIT"""');

    // Gone from Ollama: the manifest, the now-empty repo folder is fine to keep
    // only while a sibling tag remains, and every blob nothing else references.
    expect(existsSync(m.path)).toBe(false);
    const blobs = readdirSync(join(r.ollama, "blobs")).sort();
    expect(blobs).not.toContain(`sha256-${sha(1)}`);
    expect(blobs).not.toContain(`sha256-${sha(3)}`);
    expect(blobs).toContain(`sha256-${sha(2)}`); // shared with qwen3:4b
    expect(blobs).toContain(`sha256-${sha(6)}`);
    expect(blobs).toContain(`sha256-${sha(999)}`); // config, shared
    const after = await scan(r);
    expect(after.stores.find((s) => s.runtime === "ollama")!.models.map((x) => x.name)).toEqual(["qwen3:4b"]);
  });

  it("removes the repo folder when its last tag is exported", async () => {
    const base = tempRoot("lasttag");
    const r = roots(base);
    ollamaStore(r.ollama, { "llama3.2:3b": [[sha(1), 100]] });
    const m = await find(r, "ollama:llama3.2:3b");
    await moveModel(m, r, join(base, "dest"), undefined, { freeBytes: plenty });
    expect(existsSync(join(r.ollama, "manifests", "registry.ollama.ai", "library", "llama3.2"))).toBe(false);
  });
});
