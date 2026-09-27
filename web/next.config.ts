import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Keep the PostgreSQL driver stack out of the server bundle.
   *
   * `@prisma/client`, `@prisma/adapter-pg`, and `pg` must be `require`d from
   * `node_modules` at runtime, not inlined: the adapter opens a real socket pool
   * and the client loads a native/WASM query compiler, neither of which
   * bundling improves. This is the configuration Prisma documents for Next, and
   * it is also what unblocks the Windows build — Turbopack stages external
   * packages into `.next/node_modules` via directory junctions, and creating
   * those fails with `Access is denied (os error 5)` unless Developer Mode is on
   * or the process is elevated.
   *
   * The generated client itself (`src/generated/prisma`) is app-owned generated
   * code and *is* bundled; only the runtime it imports from is externalised.
   *
   * `serverExternalPackages` is necessary but NOT sufficient on Windows:
   * Turbopack still stages externals into `.next/node_modules` through
   * directory junctions, and that fails with `Access is denied (os error 5)` on
   * any machine without Developer Mode or elevation. The `dev` and `build`
   * scripts therefore pass `--webpack`, which does not use junctions. Drop that
   * flag once junctions are creatable — see the note in `package.json`.
   */
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],

  /**
   * Turbopack resolves modules relative to this root, and only files *above* it
   * are resolvable. The default is the app directory, which would make the
   * repository's generated design tokens unreachable from
   * `src/app/globals.css`.
   *
   * The design tokens are a build input, not app-owned code:
   * `dist/tokens.css` is generated and committed by the token pipeline at the
   * repository root (see the root README and `AGENTS.md §11.1`). Pointing
   * Turbopack's root at the repository root lets the app import that single
   * committed artefact, so there is exactly one copy of the tokens and no
   * second token system. Regenerate with `npm run build` from the repository
   * root; verify with `npm run check`.
   */
  turbopack: {
    root: path.join(import.meta.dirname, ".."),
  },
};

export default nextConfig;
