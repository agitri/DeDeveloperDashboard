/**
 * Anthropic Messages API. Port of `ai/anthropic.rs`.
 *
 * Raw HTTP rather than an SDK: one endpoint with one request shape. Three
 * things here are easy to get wrong and are pinned deliberately:
 *   * `max_tokens` bounds thinking *and* text on Claude Opus 5, so it is sized
 *     for the answer plus room to reason.
 *   * `temperature` / `top_p` / `top_k` are rejected on current models. Steer
 *     with the prompt; there is nothing to tune here.
 *   * A refusal arrives as HTTP 200 with `stop_reason: "refusal"` and possibly
 *     an empty `content` array. Reading `content[0]` first would throw on
 *     exactly the responses that most need handling.
 */
import { DddError } from "../error";
import { statusLabel } from "../sync/adapter";
import { asInt, asStr, at, costMicros, errorText, type Completion, type Draft, type LLMProvider } from "./provider";

export const API = "https://api.anthropic.com/v1/messages";
export const VERSION = "2023-06-01";

export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic";

  constructor(
    private readonly fetch: typeof globalThis.fetch,
    private readonly apiKey: string,
  ) {}

  async complete(completion: Completion): Promise<Draft> {
    if (this.apiKey === "") {
      throw DddError.config("No Anthropic API key. Add one in Settings → AI.");
    }

    const body = {
      model: completion.model,
      max_tokens: completion.maxTokens,
      system: completion.system,
      // `effort` controls how much the model spends thinking. Board actions
      // are short and interactive, so medium is the right trade.
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: completion.prompt }],
    };

    let response: Response;
    try {
      response = await this.fetch(API, {
        method: "POST",
        headers: { "x-api-key": this.apiKey, "anthropic-version": VERSION, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw DddError.config(`anthropic request failed: ${errorText(e)}`);
    }

    const text = await response.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const detail = asStr(at(parsed, "error/message")) ?? text;
      // 429 and 529 are the retryable ones; the user's next click is the
      // retry, so the message just has to say which kind it was.
      throw DddError.config(`anthropic ${statusLabel(response)}: ${detail}`);
    }

    const model = asStr(at(parsed, "model")) ?? completion.model;
    const inputTokens = asInt(at(parsed, "usage/input_tokens")) ?? 0;
    const outputTokens = asInt(at(parsed, "usage/output_tokens")) ?? 0;
    const usage = { inputTokens, outputTokens, costMicros: costMicros(model, inputTokens, outputTokens) };

    // Check the stop reason *before* touching content.
    if (asStr(at(parsed, "stop_reason")) === "refusal") {
      const explanation = asStr(at(parsed, "stop_details/explanation")) ?? "The model declined this request.";
      return { text: "", model, usage, refusal: explanation };
    }

    // `content` is a list of typed blocks; only the text ones are the answer.
    const blocks = at(parsed, "content");
    const textOut = Array.isArray(blocks)
      ? blocks
          .filter((b) => asStr(at(b, "type")) === "text")
          .map((b) => asStr(at(b, "text")))
          .filter((t): t is string => t !== null)
          .join("")
      : "";

    return { text: textOut, model, usage, refusal: null };
  }
}
