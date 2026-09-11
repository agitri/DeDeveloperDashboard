/**
 * Ollama and any OpenAI-compatible endpoint. Port of `ai/local.rs`.
 *
 * Two providers in one file because they are the same idea: an HTTP endpoint
 * on the user's own machine or network, holding a model the user chose. Both
 * report token counts so local work still shows up on the stats board — at
 * zero cost, which is rather the point.
 */
import { DddError } from "../error";
import { asInt, asStr, at, errorText, type Completion, type Draft, type LLMProvider } from "./provider";

/** Rust's `trim_end_matches('/')`: every trailing slash, not just one. */
const trimSlashes = (s: string): string => s.replace(/\/+$/, "");

async function readJson(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (e) {
    throw DddError.config(`${label}: ${errorText(e)}`);
  }
}

export class OllamaProvider implements LLMProvider {
  readonly id = "local";

  constructor(
    private readonly fetch: typeof globalThis.fetch,
    private readonly baseUrl: string,
  ) {}

  async complete(completion: Completion): Promise<Draft> {
    const url = `${trimSlashes(this.baseUrl)}/api/chat`;
    const body = {
      model: completion.model,
      stream: false,
      options: { num_predict: completion.maxTokens },
      messages: [
        { role: "system", content: completion.system },
        { role: "user", content: completion.prompt },
      ],
    };

    let response: Response;
    try {
      response = await this.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      throw DddError.config(`Ollama is not answering at ${this.baseUrl}. Is it running? (${errorText(e)})`);
    }

    const parsed = await readJson(response, "ollama returned unreadable JSON");
    const error = asStr(at(parsed, "error"));
    if (error !== null) throw DddError.config(`ollama: ${error}`);

    return {
      text: asStr(at(parsed, "message/content")) ?? "",
      model: completion.model,
      usage: {
        inputTokens: asInt(at(parsed, "prompt_eval_count")) ?? 0,
        outputTokens: asInt(at(parsed, "eval_count")) ?? 0,
        costMicros: 0,
      },
      refusal: null,
    };
  }
}

/** LM Studio, llama.cpp server, vLLM — anything speaking `/v1/chat/completions`. */
export class OpenAiCompatProvider implements LLMProvider {
  readonly id = "openai-compatible";

  constructor(
    private readonly fetch: typeof globalThis.fetch,
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async complete(completion: Completion): Promise<Draft> {
    // `trim_end_matches("/v1")` strips every trailing `/v1`, then one is put back.
    let base = trimSlashes(this.baseUrl);
    while (base.endsWith("/v1")) base = base.slice(0, -3);
    const url = `${base}/v1/chat/completions`;

    const headers: Record<string, string> = { "content-type": "application/json" };
    // Local servers usually ignore auth entirely; send it only if set.
    if (this.apiKey !== "") headers["authorization"] = `Bearer ${this.apiKey}`;

    const body = {
      model: completion.model,
      max_tokens: completion.maxTokens,
      messages: [
        { role: "system", content: completion.system },
        { role: "user", content: completion.prompt },
      ],
    };

    let response: Response;
    try {
      response = await this.fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) {
      throw DddError.config(`endpoint ${this.baseUrl} did not answer: ${errorText(e)}`);
    }

    const parsed = await readJson(response, "endpoint returned unreadable JSON");
    const message = asStr(at(parsed, "error/message"));
    if (message !== null) throw DddError.config(`endpoint: ${message}`);

    return {
      text: asStr(at(parsed, "choices/0/message/content")) ?? "",
      model: completion.model,
      usage: {
        inputTokens: asInt(at(parsed, "usage/prompt_tokens")) ?? 0,
        outputTokens: asInt(at(parsed, "usage/completion_tokens")) ?? 0,
        costMicros: 0,
      },
      refusal: null,
    };
  }
}
