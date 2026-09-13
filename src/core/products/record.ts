/**
 * What DDD remembers about a product it started, and whether it may still
 * believe it. Port of `products/record.rs`.
 *
 * A product outlives DDD, so across a restart the only thing left is a number
 * in a file. PIDs are recycled, so the record is checked against the kernel's
 * start time for that PID: a recycled PID belongs to a process that started
 * later, so a matching start time answers the reuse question on its own. The
 * process *name* is recorded but not gated on — a login shell that `exec`s the
 * command changes its name mid-life for one unbroken process. Everything here
 * is pure over its inputs.
 */
import { isNumber, isString, optional, record, required } from "../json";

/** What the OS says about a PID right now. */
export interface ProcInfo {
  /** The kernel's start time, verbatim and unparsed. Only ever compared to
   *  another reading of the same field, so its format is not our business. */
  startedAt: string;
  /** The executable's name. Recorded for display; see `claim`. */
  command: string;
}

/** One product DDD started and has not seen stop. Field order matches the
 *  on-disk shape (`products.json`). */
export interface Record {
  /** `<projectId>/<productId>` — unique within an environment. */
  key: string;
  projectId: string;
  productId: string;
  pid: number;
  /** The OS start time read at spawn. The whole guard rests on this. */
  startedAt: string;
  /** The command name as it was at spawn. Display only. */
  command: string;
  /** Our own clock at spawn, for showing uptime. Never used to decide. */
  since: string;
}

export function recordFromJson(raw: unknown): Record {
  const o = record(raw, "record");
  return {
    key: required(o, "key", isString),
    projectId: required(o, "projectId", isString),
    productId: required(o, "productId", isString),
    pid: required(o, "pid", isNumber),
    startedAt: required(o, "startedAt", isString),
    command: optional(o, "command", isString, ""),
    since: required(o, "since", isString),
  };
}

/** Whether a record still describes the process it was written for. */
export type Claim =
  | { kind: "ours" }
  | { kind: "gone" }
  | { kind: "reused"; now: string };

/** Does this record still hold? The start time is the entire test; the command
 *  name deliberately is not. */
export function claim(rec: Record, now?: ProcInfo | null): Claim {
  if (now === undefined || now === null) return { kind: "gone" };
  if (now.startedAt !== rec.startedAt) {
    return { kind: "reused", now: `${now.command} (pid ${rec.pid})` };
  }
  return { kind: "ours" };
}

/** How a product is doing. Mirrors the renderer's `ProductState`. `unknown` is
 *  a first-class answer, not an error: the app never claims health it has not
 *  verified. */
export type State =
  | { state: "running"; pid: number; since: string }
  | { state: "stopped" }
  | { state: "exited"; since: string }
  | { state: "unknown"; why: string };

/** Turn a record and a live reading into the state a widget draws. */
export function stateOf(rec?: Record, now?: ProcInfo | null): State {
  if (rec === undefined) return { state: "stopped" };
  const c = claim(rec, now);
  if (c.kind === "ours") return { state: "running", pid: rec.pid, since: rec.since };
  if (c.kind === "gone") return { state: "exited", since: rec.since };
  return { state: "unknown", why: `pid ${rec.pid} belongs to ${c.now} now, not to this product` };
}
