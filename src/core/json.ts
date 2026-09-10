/**
 * Serde's per-field defaults and "missing field" errors, made explicit. Every
 * `fromJson` normalizer in `models.ts` and `settings.ts` is built from these.
 */
import { DddError } from "./error";

export function record(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw DddError.json(`invalid type: expected ${what} object`);
  }
  return raw as Record<string, unknown>;
}

export function required<T>(obj: Record<string, unknown>, field: string, guard: (v: unknown) => v is T): T {
  const v = obj[field];
  if (v === undefined) throw DddError.json(`missing field \`${field}\``);
  if (!guard(v)) throw DddError.json(`invalid type for field \`${field}\``);
  return v;
}

export const isString = (v: unknown): v is string => typeof v === "string";
export const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
export const isArray = (v: unknown): v is unknown[] => Array.isArray(v);

export function optional<T>(obj: Record<string, unknown>, field: string, guard: (v: unknown) => v is T, fallback: T): T {
  const v = obj[field];
  if (v === undefined || v === null) return fallback;
  if (!guard(v)) throw DddError.json(`invalid type for field \`${field}\``);
  return v;
}

export function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
