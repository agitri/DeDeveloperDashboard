/**
 * The body of the `ddd:invoke` handler, pulled out of `ipc.ts` so it is
 * testable as a plain function — no `BrowserWindow`, no real Electron `app`.
 * Never imports `electron`: `event` is opaque here, passed through to
 * whichever host handler asked for it.
 */
import type { Handler } from "./commands";

export type Envelope = { ok: true; value: unknown } | { ok: false; error: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HostHandler = (args: Record<string, any>, event: unknown) => unknown;

/**
 * `host` wins over `commands` for the same name — the dialogs/shell commands
 * that were Tauri plugins live in `host`, and nothing in `commands` is meant
 * to be shadowed, but a caller building both maps should never have to worry
 * about the order.
 */
export async function dispatch(
  cmd: unknown,
  args: unknown,
  event: unknown,
  host: Record<string, HostHandler>,
  commands: Record<string, Handler>,
): Promise<Envelope> {
  const name = String(cmd);
  // Object.hasOwn, not `in` / bracket lookup: a renderer sending "constructor"
  // or "toString" must get "unknown command", not Object.prototype's own.
  const handler: HostHandler | Handler | undefined = Object.hasOwn(host, name)
    ? host[name]
    : Object.hasOwn(commands, name)
      ? commands[name]
      : undefined;
  if (!handler) return { ok: false, error: `unknown command ${name}` };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const value = await handler((args as Record<string, any>) ?? {}, event);
    return { ok: true, value: value === undefined ? null : value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
