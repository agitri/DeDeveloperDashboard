/**
 * Placeholder — Task 6 replaces this with the real GitHub adapter (port of
 * `sync/github.rs`). Kept here now only so `./providers` has something to
 * resolve `"github"` to.
 */
import { DddError } from "../error";
import type { ActionRequest, FetchContext, SourceAdapter } from "./adapter";
import { refuse } from "./adapter";
import type { Item } from "../models";

export class GitHubAdapter implements SourceAdapter {
  readonly source = "github";

  async fetch(): Promise<Item[]> {
    throw DddError.config("github not ported yet");
  }

  async perform(_cx: FetchContext, r: ActionRequest): Promise<string> {
    return refuse(this.source, r.action);
  }
}
