import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Standalone build for the emdash-mcp subprocess. Output: out/mcp-server/index.cjs
 *
 * Bundled to a single CJS file invoked as `node out/mcp-server/index.cjs` (or
 * shipped inside Electron's resources dir). The subprocess is spawned by the
 * agent CLI — not by Electron — so it cannot resolve requires from inside an
 * ASAR archive. `ssr.noExternal: true` forces every npm dep (incl. MCP SDK +
 * zod) into the bundle; only Node built-ins stay external.
 */
export default defineConfig({
  build: {
    outDir: 'out/mcp-server',
    emptyOutDir: true,
    target: 'node20',
    ssr: true,
    minify: false,
    lib: {
      entry: resolve('src/mcp-server/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.cjs',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  ssr: {
    noExternal: true,
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
    },
  },
});
