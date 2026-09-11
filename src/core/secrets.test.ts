import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
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

/**
 * The Rust app stores secrets with the `keyring` crate as a macOS generic
 * password: service `ddd:<env>`, account `<key>`. If this port writes the same
 * attributes, the two apps can read each other's tokens. `security` is the
 * OS's own reader, so it is the neutral referee.
 */
describe.skipIf(!process.env.DDD_VERIFY || process.platform !== "darwin")("keychain interop (live, macOS)", () => {
  it("writes a generic password the OS finds under ddd:<env> / <key>", () => {
    const { env } = scratchEnv("interop");
    const key = `interop-${Date.now()}`;
    secrets.set(env, key, "shared-secret");
    try {
      const out = execFileSync("security", ["find-generic-password", "-s", env.keychainService(), "-a", key, "-w"], { encoding: "utf8" });
      expect(out.trim()).toBe("shared-secret");
    } finally {
      secrets.del(env, key);
    }
  });
});
