// Playwright E2E — the CEO's drill, automated.
//
// This exists because a ten-minute manual drill found what 132 unit tests and
// five review rounds did not: a stuck session slot, discovered by clicking the
// real button on the real deployment. Unit tests exercise the modules; THIS
// exercises the product — real browser, real Worker, real Durable Object, real
// agent. The paths it walks (Start → Stop → Start, the busy refusal) are
// exactly the ones no unit test can reach.
//
// DELIBERATELY NOT IN CI. It needs the admin password (a secret CI does not
// hold), it consumes the production agent slot, and a mid-run crash could hold
// that slot — the suite resets the registry before and after, but CI running
// unattended on every push would contend with real drills. It is an on-demand
// instrument, like scripts/check-live.sh:
//
//   npm run e2e            # against production (the default)
//   E2E_BASE_URL=... npm run e2e
//
// The password is read from the gitignored secrets.env by the npm script and
// travels only as an environment variable — never argv, never committed.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // ONE worker, no parallelism, no retries: production has one session slot,
  // and two tests racing for it would manufacture the exact busy state the
  // suite is trying to detect. A retry would likewise mask a leak — the second
  // attempt "passing" because the first one's crash was reaped.
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'https://studio.luminastream.live',
    // Evidence by default: every run leaves screenshots and a trace, so a
    // failure attaches to a PR as pictures rather than prose.
    screenshot: 'on',
    trace: 'retain-on-failure',
    permissions: ['microphone'],
    launchOptions: {
      args: [
        // A fake mic, granted without a prompt dialog. The lens publishes a
        // real audio track from it — the pipeline is exercised end to end
        // without a human at a headset.
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
});
