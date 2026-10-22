import { describe, expect, it } from "vitest";
import { OllamaProvider, OpenAiCompatProvider } from "./local";
import type { Completion } from "./provider";

const completion: Completion = { system: "sys", prompt: "hello", maxTokens: 1024, model: "llama3.1:8b" };

function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, reqInit?: RequestInit) => {
    calls.push({ url: String(url), init: reqInit ?? {} });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("OllamaProvider", () => {
  it("posts a non-streaming chat with system and user turns, and echoes the requested model", async () => {
    const { fetch, calls } = fakeFetch({ message: { role: "assistant", content: "Sure." }, prompt_eval_count: 40, eval_count: 3 });
    const draft = await new OllamaProvider(fetch, "http://localhost:11434/").complete(completion);
    expect(calls[0]!.url).toBe("http://localhost:11434/api/chat");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: "llama3.1:8b",
      stream: false,
      options: { num_predict: 1024 },
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
      ],
    });
    expect(draft).toEqual({
      text: "Sure.",
      model: "llama3.1:8b",
      usage: { inputTokens: 40, outputTokens: 3, costMicros: 0 },
      refusal: null,
    });
  });

  it("says where it looked when Ollama is not running", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    await expect(new OllamaProvider(fetch, "http://localhost:11434").complete(completion)).rejects.toThrow(
      "Ollama is not answering at http://localhost:11434. Is it running? (fetch failed)",
    );
  });

  it("surfaces Ollama's own error and an unreadable body", async () => {
    await expect(
      new OllamaProvider(fakeFetch({ error: "model 'x' not found" }, 404).fetch, "http://h").complete(completion),
    ).rejects.toThrow("ollama: model 'x' not found");
    await expect(new OllamaProvider(fakeFetch("<nope>").fetch, "http://h").complete(completion)).rejects.toThrow(
      /^ollama returned unreadable JSON: /,
    );
  });

  it("a reply without counts or content is an empty, free draft", async () => {
    const draft = await new OllamaProvider(fakeFetch({}).fetch, "http://h").complete(completion);
    expect(draft).toEqual({ text: "", model: "llama3.1:8b", usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 }, refusal: null });
  });
});

describe("OpenAiCompatProvider", () => {
  it("normalizes the base URL onto /v1/chat/completions, with or without a trailing /v1", async () => {
    for (const base of ["http://host:1234", "http://host:1234/", "http://host:1234/v1", "http://host:1234/v1/"]) {
      const { fetch, calls } = fakeFetch({ choices: [{ message: { content: "ok" } }] });
      await new OpenAiCompatProvider(fetch, base, "").complete(completion);
      expect(calls[0]!.url, base).toBe("http://host:1234/v1/chat/completions");
    }
  });

  it("sends a bearer token only when there is one", async () => {
    const a = fakeFetch({ choices: [{ message: { content: "ok" } }] });
    await new OpenAiCompatProvider(a.fetch, "http://h", "").complete(completion);
    expect((a.calls[0]!.init.headers as Record<string, string>)["authorization"]).toBeUndefined();

    const b = fakeFetch({ choices: [{ message: { content: "ok" } }] });
    await new OpenAiCompatProvider(b.fetch, "http://h", "tok").complete(completion);
    expect((b.calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
    expect(JSON.parse(b.calls[0]!.init.body as string)).toEqual({
      model: "llama3.1:8b",
      max_tokens: 1024,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
      ],
    });
  });

  it("reads the first choice and the usage block, at zero cost", async () => {
    const { fetch } = fakeFetch({ choices: [{ message: { content: "Answer" } }], usage: { prompt_tokens: 7, completion_tokens: 2 } });
    const draft = await new OpenAiCompatProvider(fetch, "http://h", "").complete(completion);
    expect(draft).toEqual({
      text: "Answer",
      model: "llama3.1:8b",
      usage: { inputTokens: 7, outputTokens: 2, costMicros: 0 },
      refusal: null,
    });
  });

  it("reports the endpoint's error, an unreadable body, and a dead endpoint", async () => {
    await expect(
      new OpenAiCompatProvider(fakeFetch({ error: { message: "model not loaded" } }, 400).fetch, "http://h", "").complete(completion),
    ).rejects.toThrow("endpoint: model not loaded");
    await expect(new OpenAiCompatProvider(fakeFetch("nope").fetch, "http://h", "").complete(completion)).rejects.toThrow(
      /^endpoint returned unreadable JSON: /,
    );
    const dead = (async () => {
      throw new TypeError("ECONNREFUSED");
    }) as typeof globalThis.fetch;
    await expect(new OpenAiCompatProvider(dead, "http://h:1", "").complete(completion)).rejects.toThrow(
      "endpoint http://h:1 did not answer: ECONNREFUSED",
    );
  });
});
