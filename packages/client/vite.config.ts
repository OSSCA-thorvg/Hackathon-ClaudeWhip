import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vite';

const require = createRequire(import.meta.url);
/**
 * The real file path of the thorvg WASM. @thorvg/webcanvas's package.json exports only expose
 * '.' and './thread', so the `@thorvg/webcanvas/dist/thorvg.wasm?url` deep import is blocked
 * as-is (vite 8: "is not exported under the conditions ..."). We derive the dist directory back
 * from the entry point and punch through with an alias — a workaround so we never fall back to
 * the CDN (see the pitfalls in CLAUDE.md).
 */
const thorvgWasmPath = join(dirname(require.resolve('@thorvg/webcanvas')), 'thorvg.wasm');

export default defineConfig(({ command }) => ({
  // GitHub Pages serves the site under /<repo>/ — build-only so the dev server keeps plain /
  base: command === 'build' ? '/Hackathon-ClaudeWhip/' : '/',
  // The Emscripten glue depends on import.meta.url — esbuild pre-bundling can break it
  optimizeDeps: {
    exclude: ['@thorvg/webcanvas'],
  },
  resolve: {
    alias: [
      // Regex alias so it still matches with the ?url query attached (no end anchor)
      { find: /^@thorvg\/webcanvas\/dist\/thorvg\.wasm/, replacement: thorvgWasmPath },
    ],
  },
}));
