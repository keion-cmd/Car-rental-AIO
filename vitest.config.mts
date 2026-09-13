import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: "./tests/global-setup.ts",
    testTimeout: 30000,
    hookTimeout: 30000,
    // Each test file opens its own set of PrismaClient/pg.Pool connections
    // (up to ~255 across the full suite). Running files in parallel by
    // default multiplies that peak far past a safe connection budget and
    // produces nondeterministic deadlocks/timeouts. Serial-by-default keeps
    // the suite's correctness signal unambiguous without relying on anyone
    // remembering a CLI flag.
    fileParallelism: false,
  },
});
