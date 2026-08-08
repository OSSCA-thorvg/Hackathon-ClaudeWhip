/**
 * Unit test runner config.
 *
 * The three workspaces are bundled as `projects` so a single root `pnpm test` runs them all.
 * The projects are defined **inline** on purpose: to avoid pulling in the packages'
 * vite.config.ts. The client's vite config carries the thorvg WASM alias (require.resolve), but
 * every module the unit tests touch is pure TS and needs none of it — all it would do is risk
 * dragging browser-only dependencies into the test graph.
 *
 * The environment is `node` everywhere. Anything that needs the DOM (the thorvg renderer, the DOM
 * UI) is out of unit-test scope and in E2E scope (Playwright + a fake bridge WS).
 */
import { defineConfig } from 'vitest/config';

/** Settings shared by every project — tests live next to the source as `*.test.ts` */
const common = {
  environment: 'node',
  include: ['src/**/*.test.ts'],
} as const;

export default defineConfig({
  test: {
    projects: [
      { test: { ...common, name: 'shared', root: './packages/shared' } },
      { test: { ...common, name: 'client', root: './packages/client' } },
      { test: { ...common, name: 'server', root: './packages/server' } },
    ],
  },
});
