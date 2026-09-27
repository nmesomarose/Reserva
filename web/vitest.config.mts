import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // The scaffold's tests are infrastructure tests (health check, environment
    // validation). No DOM is required.
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Loads .env so database-backed tests resolve DATABASE_URL.
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.join(projectRoot, "src"),
      // `server-only` deliberately throws when it is imported outside a React
      // Server environment, which is exactly what a plain Node test runner is.
      // Aliasing it to an empty stub keeps the `import "server-only"` guard in
      // src/server/* meaningful in the app build while letting tests import
      // those modules. The guard itself is enforced by `next build`.
      "server-only": path.join(projectRoot, "tests/stubs/server-only.ts"),
    },
  },
});
