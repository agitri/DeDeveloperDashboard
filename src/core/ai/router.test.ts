import { describe, expect, it } from "vitest";
import { scratchEnv } from "../testing";
import { defaultSettings } from "../settings";
import { memorySecrets } from "../sync/adapter";
import { AnthropicProvider } from "./anthropic";
import { OllamaProvider, OpenAiCompatProvider } from "./local";
import { ANTHROPIC_KEY, OPENAI_COMPAT_KEY, route } from "./router";

const noFetch = (async () => {
  throw new Error("no network in tests");
}) as typeof globalThis.fetch;

describe("route", () => {
  it("routes by the action's entry, then by the default provider", () => {
    const { env } = scratchEnv("route-default");
    const deps = { fetch: noFetch, secrets: memorySecrets() };
    const s = defaultSettings();

    const summarize = route(env, s, "thread.summarize", deps);
    expect(summarize.provider).toBeInstanceOf(OllamaProvider);
    expect(summarize.provider.id).toBe("local");
    expect(summarize.model).toBe("llama3.1:8b");

    const draft = route(env, s, "mail.draft", deps);
    expect(draft.provider).toBeInstanceOf(AnthropicProvider);
    expect(draft.model).toBe("claude-opus-5");

    // An action nobody routed falls back to the default provider.
    const unknownAction = route(env, s, "code.review", deps);
    expect(unknownAction.provider.id).toBe("anthropic");
  });

  it("reads the Anthropic key from the environment's keychain, and an absent key is empty", async () => {
    const { env } = scratchEnv("route-key");
    const secrets = memorySecrets();
    const deps = { fetch: noFetch, secrets };
    const s = defaultSettings();
    // No key yet: the provider builds, and refuses at call time — as the Rust does.
    await expect(route(env, s, "mail.draft", deps).provider.complete({ system: "", prompt: "", maxTokens: 1, model: "m" })).rejects.toThrow(
      "No Anthropic API key",
    );
    secrets.set(env, ANTHROPIC_KEY, "sk-live");
    // With a key it gets as far as the network, which this test forbids.
    await expect(route(env, s, "mail.draft", deps).provider.complete({ system: "", prompt: "", maxTokens: 1, model: "m" })).rejects.toThrow(
      "anthropic request failed: no network in tests",
    );
  });

  it("openai-compatible needs an endpoint, and reads its own key", () => {
    const { env } = scratchEnv("route-openai");
    const secrets = memorySecrets();
    const deps = { fetch: noFetch, secrets };
    const s = defaultSettings();
    s.ai.routing["thread.summarize"] = "openai-compatible";
    expect(() => route(env, s, "thread.summarize", deps)).toThrow("No OpenAI-compatible endpoint set in Settings → AI.");
    s.ai.openaiCompatibleUrl = "";
    expect(() => route(env, s, "thread.summarize", deps)).toThrow("No OpenAI-compatible endpoint set in Settings → AI.");

    s.ai.openaiCompatibleUrl = "http://localhost:1234/v1";
    s.ai.openaiModel = "qwen";
    secrets.set(env, OPENAI_COMPAT_KEY, "tok");
    const r = route(env, s, "thread.summarize", deps);
    expect(r.provider).toBeInstanceOf(OpenAiCompatProvider);
    expect(r.model).toBe("qwen");
  });

  it("refuses a provider it does not know, by name", () => {
    const { env } = scratchEnv("route-unknown");
    const s = defaultSettings();
    s.ai.routing["thread.summarize"] = "ollama";
    expect(() => route(env, s, "thread.summarize", { fetch: noFetch, secrets: memorySecrets() })).toThrow('unknown AI provider "ollama"');
  });

  it("does not fill in default routing itself — it reads the settings as given", () => {
    const { env } = scratchEnv("route-raw");
    const s = defaultSettings();
    s.ai.routing = {};
    s.ai.defaultProvider = "local";
    expect(route(env, s, "widget.instructions", { fetch: noFetch, secrets: memorySecrets() }).provider.id).toBe("local");
  });
});
