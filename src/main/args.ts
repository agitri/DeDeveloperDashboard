/**
 * Checks what arrived over IPC against the shared command table, so a
 * handler only ever sees the types it declared. Wrong input fails the same
 * way a malformed file does — a `json:` error with the field named — because
 * from main's point of view the renderer is just another untrusted source.
 */
import { DddError } from "../core/error";
import { isBoolean, isNumber, isString, record } from "../core/json";
import { COMMANDS, type CommandName, type ParsedArgs } from "../shared/commands";

export function parseArgs<K extends CommandName>(cmd: K, raw: unknown): ParsedArgs<K> {
  const given = raw === undefined || raw === null ? {} : record(raw, `${cmd} arguments`);
  const out: Record<string, unknown> = {};
  for (const [field, kind] of Object.entries(COMMANDS[cmd] as Record<string, string>)) {
    const optional = kind.endsWith("?");
    const base = optional ? kind.slice(0, -1) : kind;
    const value = given[field];
    if (value === undefined || value === null) {
      if (!optional) throw DddError.json(`${cmd}: missing field \`${field}\``);
      out[field] = undefined;
      continue;
    }
    const ok =
      base === "json" ||
      (base === "string" && isString(value)) ||
      (base === "number" && isNumber(value)) ||
      (base === "boolean" && isBoolean(value));
    if (!ok) throw DddError.json(`${cmd}: invalid type for field \`${field}\`, expected ${base}`);
    out[field] = value;
  }
  return out as ParsedArgs<K>;
}

/** Wrap a table of typed handlers so each parses its own arguments first.
 *  Synchronous on purpose: a handler that throws synchronously must keep
 *  doing so, which is what the layout_save test relies on. */
export function validated<K extends CommandName, R extends unknown[]>(handlers: {
  [C in K]: (args: ParsedArgs<C>, ...rest: R) => unknown;
}): Record<string, (raw: Record<string, unknown>, ...rest: R) => unknown> {
  const out: Record<string, (raw: Record<string, unknown>, ...rest: R) => unknown> = {};
  for (const name of Object.keys(handlers) as K[]) {
    const handler = handlers[name];
    out[name] = (raw, ...rest) => handler(parseArgs(name, raw), ...rest);
  }
  return out;
}
