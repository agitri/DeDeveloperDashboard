import { describe, expect, it } from "vitest";
import { API, AnthropicProvider, VERSION } from "./anthropic";
import type { Completion } from "./provider";

const completion: Completion = { system: "sys", prompt: "hello", maxTokens: 4096, model: "claude-opus-5" };

/** A fetch that answers with one canned body and records what it was asked. */
function fakeFetch(body: unknown, init: { status?: number; statusText?: string } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, reqInit?: RequestInit) => {
    calls.push({ url: String(url), init: reqInit ?? {} });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, {
      status: init.status ?? 200,
      statusText: init.statusText ?? "",
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("AnthropicProvider", () => {
  it("refuses to run without a key, before touching the network", async () => {
    const { fetch, calls } = fakeFetch({});
    await expect(new AnthropicProvider(fetch, "").complete(completion)).rejects.toThrow("No Anthropic API key. Add one in Settings → AI.");
    expect(calls).toHaveLength(0);
  });

  it("sends the messages request the Rust sends: headers, version, effort, one user turn", async () => {
    const { fetch, calls } = fakeFetch({
      model: "claude-opus-5-20260101",
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        { type: "thinking", thinking: "…" },
        { type: "text", text: "Hi " },
        { type: "text", text: "there" },
      ],
    });
    const draft = await new AnthropicProvider(fetch, "sk-test").complete(completion);

    expect(calls[0]!.url).toBe(API);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe(VERSION);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: "claude-opus-5",
      max_tokens: 4096,
      system: "sys",
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: "hello" }],
    });

    // Only the text blocks are the answer; the model name comes from the reply.
    expect(draft).toEqual({
      text: "Hi there",
      model: "claude-opus-5-20260101",
      usage: { inputTokens: 100, outputTokens: 10, costMicros: 0 },
      refusal: null,
    });
  });

  it("prices by the model in the reply, falling back to the requested one", async () => {
    const { fetch } = fakeFetch({ usage: { input_tokens: 1000, output_tokens: 1000 }, content: [{ type: "text", text: "x" }] });
    const draft = await new AnthropicProvider(fetch, "k").complete(completion);
    expect(draft.model).toBe("claude-opus-5");
    expect(draft.usage.costMicros).toBe(30_000);
  });

  it("a refusal is HTTP 200 with an empty content array — an outcome, not an error", async () => {
    const { fetch } = fakeFetch({
      model: "claude-opus-5",
      stop_reason: "refusal",
      stop_details: { explanation: "Not this." },
      usage: { input_tokens: 5, output_tokens: 0 },
      content: [],
    });
    const draft = await new AnthropicProvider(fetch, "k").complete(completion);
    expect(draft.refusal).toBe("Not this.");
    expect(draft.text).toBe("");
    expect(draft.usage).toEqual({ inputTokens: 5, outputTokens: 0, costMicros: 25 });
  });

  it("a refusal without an explanation gets the stock sentence", async () => {
    const { fetch } = fakeFetch({ stop_reason: "refusal", content: [] });
    const draft = await new AnthropicProvider(fetch, "k").complete(completion);
    expect(draft.refusal).toBe("The model declined this request.");
  });

  it("a non-2xx reply is a config error naming status, reason and the API's message", async () => {
    const { fetch } = fakeFetch(
      { error: { type: "authentication_error", message: "invalid x-api-key" } },
      { status: 401, statusText: "Unauthorized" },
    );
    await expect(new AnthropicProvider(fetch, "k").complete(completion)).rejects.toThrow("anthropic 401 Unauthorized: invalid x-api-key");
  });

  it("a non-JSON error body is reported as-is", async () => {
    const { fetch } = fakeFetch("<html>overloaded</html>", { status: 529, statusText: "" });
    await expect(new AnthropicProvider(fetch, "k").complete(completion)).rejects.toThrow("anthropic 529: <html>overloaded</html>");
  });

  it("a network failure is a config error with the cause", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    await expect(new AnthropicProvider(fetch, "k").complete(completion)).rejects.toThrow("anthropic request failed: fetch failed");
  });

  it("missing usage counts are zero, and a non-integer count is not a count", async () => {
    const { fetch } = fakeFetch({ usage: { input_tokens: 1.5 }, content: [{ type: "text", text: "x" }] });
    const draft = await new AnthropicProvider(fetch, "k").complete(completion);
    expect(draft.usage).toEqual({ inputTokens: 0, outputTokens: 0, costMicros: 0 });
  });
});
