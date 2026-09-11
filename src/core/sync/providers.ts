/** Build the adapter for a connection, or null when the provider has no
 *  adapter yet — an unimplemented provider is an absence, not an error, so a
 *  half-configured board still syncs the rest. Kept apart from adapter.ts so
 *  the adapters can import the port without a cycle. */
import type { SourceAdapter } from "./adapter";
import { GitHubAdapter } from "./github";
import { MockAdapter } from "./mock";

export function forProvider(provider: string): SourceAdapter | null {
  switch (provider) {
    case "github":
      return new GitHubAdapter();
    case "mock":
      return new MockAdapter();
    default:
      return null;
  }
}
