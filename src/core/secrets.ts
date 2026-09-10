/**
 * Secrets live in the OS keychain, never in config files. Port of `secrets.rs`.
 *
 * The frontend can ask whether a secret *exists* and can set or delete one; it
 * can never read one back. `get` exists for adapters and is not registered as a
 * command — that asymmetry is the architectural half of "nothing leaves
 * without approval".
 *
 * `@napi-rs/keyring` binds the same Rust `keyring` crate the Tauri app uses, so
 * an entry either app writes is readable by the other.
 */
import { Entry } from "@napi-rs/keyring";
import { DddError } from "./error";
import type { EnvRoot } from "./paths";

function entry(env: EnvRoot, key: string): Entry {
  return new Entry(env.keychainService(), key);
}

export function set(env: EnvRoot, key: string, value: string): void {
  try {
    entry(env, key).setPassword(value);
  } catch (e) {
    throw DddError.keychain(e);
  }
}

export function exists(env: EnvRoot, key: string): boolean {
  return get(env, key) !== null;
}

export function del(env: EnvRoot, key: string): void {
  try {
    // Returns false when there was nothing to delete; that is not an error.
    entry(env, key).deletePassword();
  } catch (e) {
    throw DddError.keychain(e);
  }
}

/** Read side: adapters only. Never register this as a command. */
export function get(env: EnvRoot, key: string): string | null {
  try {
    return entry(env, key).getPassword() ?? null;
  } catch (e) {
    throw DddError.keychain(e);
  }
}
