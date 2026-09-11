/**
 * Per-action model routing. Port of `ai/router.rs`.
 *
 * Defaults do the protecting: classification and summaries route local, where
 * small models are genuinely good; drafting and code route to Claude. Users
 * can override any of it.
 *
 * The routing map is read as given. `settingsLoad` already fills in default
 * routing keys on this side, so a command that loads settings and routes
 * behaves exactly like the Rust command path.
 */
import { DddError } from "../error";
import type { EnvRoot } from "../paths";
import type { Settings } from "../settings";
import type { SecretStore } from "../sync/adapter";
import { AnthropicProvider } from "./anthropic";
import { OllamaProvider, OpenAiCompatProvider } from "./local";
import type { LLMProvider } from "./provider";

/** Keychain keys, namespaced per environment by the service name like every
 *  other secret — a work key and a personal key never meet. */
export const ANTHROPIC_KEY = "ai:anthropic";
export const OPENAI_COMPAT_KEY = "ai:openai-compatible";

/** What routing needs from the host. `SyncDeps` satisfies it structurally. */
export interface AiDeps {
  fetch: typeof globalThis.fetch;
  secrets: SecretStore;
}

export interface Route {
  provider: LLMProvider;
  model: string;
}

/** Which provider serves this action, and with which model. */
export function route(env: EnvRoot, settings: Settings, actionId: string, deps: AiDeps): Route {
  const providerId = settings.ai.routing[actionId] ?? settings.ai.defaultProvider;

  switch (providerId) {
    case "anthropic":
      return {
        model: settings.ai.anthropicModel,
        provider: new AnthropicProvider(deps.fetch, deps.secrets.get(env, ANTHROPIC_KEY) ?? ""),
      };
    case "local":
      return {
        model: settings.ai.localModel,
        provider: new OllamaProvider(deps.fetch, settings.ai.ollamaUrl),
      };
    case "openai-compatible": {
      const baseUrl = settings.ai.openaiCompatibleUrl;
      if (baseUrl === null || baseUrl === undefined || baseUrl === "") {
        throw DddError.config("No OpenAI-compatible endpoint set in Settings → AI.");
      }
      return {
        model: settings.ai.openaiModel,
        provider: new OpenAiCompatProvider(deps.fetch, baseUrl, deps.secrets.get(env, OPENAI_COMPAT_KEY) ?? ""),
      };
    }
    default:
      throw DddError.config(`unknown AI provider ${JSON.stringify(providerId)}`);
  }
}
