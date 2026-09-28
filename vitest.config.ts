import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolve workspace packages (@bpdev/*) to their TypeScript sources: no build needed to test.
  ssr: { resolve: { conditions: ["@bpdev/source", ...defaultServerConditions] } },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
