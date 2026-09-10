/**
 * The one error type the core throws. Mirrors `error.rs`: the message is what
 * the Rust `Display` produced, because that text crosses IPC verbatim and the
 * settings pages show it.
 */
export type ErrorKind = "io" | "json" | "sqlite" | "keychain" | "config" | "notFound" | "invalid";

export class DddError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "DddError";
  }

  static config(message: string): DddError {
    return new DddError("config", message);
  }
  static notFound(message: string): DddError {
    return new DddError("notFound", message);
  }
  /** The input was found but is not usable for what was asked. */
  static invalid(message: string): DddError {
    return new DddError("invalid", message);
  }
  static io(cause: unknown): DddError {
    return new DddError("io", `io: ${text(cause)}`);
  }
  static json(cause: unknown): DddError {
    return new DddError("json", `json: ${text(cause)}`);
  }
  static sqlite(cause: unknown): DddError {
    return new DddError("sqlite", `sqlite: ${text(cause)}`);
  }
  static keychain(cause: unknown): DddError {
    return new DddError("keychain", `keychain: ${text(cause)}`);
  }
}

function text(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Node's fs errors carry a `code`; `ENOENT` is the one callers branch on. */
export function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as NodeJS.ErrnoException).code === "ENOENT";
}
