import type { Product, ProductState } from "../types";
import type { State } from "../components/Status";

/**
 * How a product's state reads on the board.
 *
 * Pure over its input so the vocabulary is testable without a process: the one
 * rule that must never slip is that `unknown` is not `up`.
 */
export function verdict(state: ProductState): { state: State; label: string; title?: string } {
  switch (state.state) {
    case "running":
      return { state: "up", label: "up", title: `pid ${state.pid}` };
    case "exited":
      // Not an error. A job that finished is the normal end of a job, and the
      // widget has no way to know whether this one was meant to stay up.
      return { state: "unknown", label: "exited" };
    case "unknown":
      return { state: "unknown", label: "unknown", title: state.why };
    case "stopped":
      // Neutral, not `down`. A product you have not started is at rest, not
      // broken — colouring it like a dead server would put a red mark on a
      // board for something nobody did anything wrong about. The word carries
      // the difference from `exited`, which is the rule: colour is never the
      // only carrier.
      return { state: "unknown", label: "not running" };
  }
}

/** Uptime, in the coarse units a glance actually reads. */
export function since(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Whether the Start button can do anything at all.
 *
 * Three separate reasons it might not, each of which the row states in words
 * rather than by graying a button with no explanation.
 */
export function blocker(product: Product): string | null {
  if (!product.dirExists) return `${product.dir} is not there — has the checkout moved?`;
  if (product.needsApproval) return product.needsApproval;
  if (product.state.state === "running") return null;
  return null;
}

/** Group products by their project, keeping declaration order within each. */
export function byProject(products: Product[]): { projectId: string; products: Product[] }[] {
  const groups: { projectId: string; products: Product[] }[] = [];
  for (const product of products) {
    const existing = groups.find((g) => g.projectId === product.projectId);
    if (existing) existing.products.push(product);
    else groups.push({ projectId: product.projectId, products: [product] });
  }
  return groups;
}
