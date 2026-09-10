import { describe, expect, it } from "vitest";
import { scratchEnv } from "./testing";
import * as secrets from "./secrets";

// The OS keychain is not a scratch directory. `DDD_VERIFY=1 npx vitest run
// src/core/secrets.test.ts` runs this against the real thing; macOS will ask
// once to allow the process.
describe.skipIf(!process.env.DDD_VERIFY)("secrets (live keychain)", () => {
  it("round-trips set / exists / delete under the ddd:<env> service", () => {
    const { env } = scratchEnv("secrets");
    const key = `test-${Date.now()}`;
    expect(secrets.exists(env, key)).toBe(false);
    secrets.set(env, key, "hunter2");
    expect(secrets.exists(env, key)).toBe(true);
    expect(secrets.get(env, key)).toBe("hunter2");
    secrets.del(env, key);
    expect(secrets.exists(env, key)).toBe(false);
    // Deleting what is not there is not an error.
    expect(() => secrets.del(env, key)).not.toThrow();
  });
});
