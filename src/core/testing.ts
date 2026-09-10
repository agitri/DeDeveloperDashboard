/**
 * Test scaffolding. `DDD_HOME` is process-global; vitest runs each test file in
 * its own process (`pool: "forks"`) and the tests inside a file sequentially,
 * so pointing it at a fresh temp directory per test is safe here. Anything
 * that constructs an `EnvRoot` in a test must go through this.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvRoot } from "./paths";

export interface ScratchEnv {
  home: string;
  env: EnvRoot;
}

/** Points `DDD_HOME` at a fresh temp directory and opens the `default`
 *  environment inside it. */
export function scratchEnv(name: string): ScratchEnv {
  const home = mkdtempSync(join(tmpdir(), `ddd-test-${name}-`));
  process.env.DDD_HOME = home;
  return { home, env: EnvRoot.open("default") };
}
