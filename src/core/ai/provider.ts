/**
 * The `LLMProvider` port. Port of `ai/provider.rs`.
 *
 * Three implementations behind one interface — Anthropic, Ollama, and any
 * OpenAI-compatible endpoint — so per-action routing is a config lookup rather
 * than a branch in every call site. Every provider returns token counts,
 * because the stats board is only honest if the numbers come from the API.
 */

/** One completion. Deliberately not a chat history: every AI action is a
 *  single shot over an item plus its project context. */
export interface Completion {
  system: string;
  prompt: string;
  /** Hard cap on the response. On thinking models this covers thinking *and*
   *  text, so it is sized for the answer plus room to reason. */
  maxTokens: number;
  /** Provider-specific model id, resolved by the router. */
  model: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Millionths of a dollar. Integer so the stats table never stores a float. */
  costMicros: number;
}

export interface Draft {
  text: string;
  model: string;
  usage: Usage;
  /** Set when the model declined rather than answered. Surfaced as-is: a
   *  refusal is an outcome, not an error to be retried blindly. */
  refusal: string | null;
}

export interface LLMProvider {
  readonly id: string;
  complete(completion: Completion): Promise<Draft>;
}

/** List price in micro-dollars per token — $5 per million tokens is exactly
 *  5 micro-dollars per token, so the table stays in integers. */
export interface Price {
  input: number;
  output: number;
}

export function priceFor(model: string): Price {
  switch (model) {
    // Claude Opus 5 — the default for drafting and code.
    case "claude-opus-5":
    case "claude-opus-4-8":
    case "claude-opus-4-7":
      return { input: 5, output: 25 };
    // Sonnet 5 lists at $3/$15; introductory pricing runs lower, so this
    // over-estimates rather than surprising anyone.
    case "claude-sonnet-5":
    case "claude-sonnet-4-6":
      return { input: 3, output: 15 };
    case "claude-haiku-4-5":
      return { input: 1, output: 5 };
    case "claude-fable-5":
    case "claude-mythos-5":
      return { input: 10, output: 50 };
    // Local models cost electricity, which this table cannot price.
    default:
      return { input: 0, output: 0 };
  }
}

export function costMicros(model: string, input: number, output: number): number {
  const price = priceFor(model);
  return input * price.input + output * price.output;
}

// --- JSON helpers shared by the providers -----------------------------------

/** `serde_json::Value::pointer` without the leading slash: `usage/input_tokens`,
 *  `content/0/text`. Undefined when any step is missing. */
export function at(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const step of path.split("/")) {
    if (Array.isArray(cur)) {
      const i = Number(step);
      cur = Number.isInteger(i) ? cur[i] : undefined;
    } else if (typeof cur === "object" && cur !== null) {
      cur = (cur as Record<string, unknown>)[step];
    } else {
      return undefined;
    }
  }
  return cur;
}

export const asStr = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** `Value::as_i64`: an integer, or nothing. A float is not an integer. */
export const asInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** What Rust's `{e}` prints for an error we caught. */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
