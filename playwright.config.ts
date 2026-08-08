/**
 * E2E runner config.
 *
 * What gets verified is the **dev build** — the `window.__claudewhip` debug handle doesn't survive
 * into the production bundle (main.ts's `import.meta.env.DEV` guard). So webServer has to be the
 * dev server, not `vite build && preview`.
 *
 * The (bridge) server is never started. The real server depends on this machine's actual Claude
 * Code sessions and is therefore non-deterministic, so a **fake bridge WS** that the tests start
 * themselves (e2e/fixtures/fake-bridge.ts) takes its place — the server is optional to begin with.
 *
 * The port is pinned with `--strictPort` — if 5173 is taken, vite quietly moves to 5174, and then
 * the URL webServer waits on no longer matches the actual server, producing a timeout with no
 * visible cause.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 5173;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  // The test timeout is the default (30s) — only the one test that waits out the reconnect backoff
  // (up to 8s) raises it locally with `test.setTimeout` (reconnect.spec.ts). Raising it globally
  // would mean a stuck test fails only after 90 seconds.
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm --filter @claudewhip/client exec vite --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
