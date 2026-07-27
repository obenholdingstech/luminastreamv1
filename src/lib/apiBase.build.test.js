// Slow test (~5s): runs a real `vite build` into a temp dir and asserts the
// configured VITE_API_BASE lands in the bundle. This is the guard the unit
// tests can't provide: Vite replaces `import.meta.env.VITE_API_BASE` only
// when it stays a static member expression — a refactor to dynamic access
// would pass every unit test and still ship '' to production.
// Run with: node --test src/lib/apiBase.build.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SENTINEL = 'https://api.wiretest.example/';

function buildBundleText(apiBase) {
  const env = { ...process.env };
  delete env.VITE_API_BASE; // isolate from the invoking shell
  if (apiBase !== undefined) env.VITE_API_BASE = apiBase;
  const outDir = mkdtempSync(join(tmpdir(), 'apiBase-build-'));
  try {
    execFileSync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
      env,
      stdio: 'pipe',
    });
    const assets = join(outDir, 'assets');
    return readdirSync(assets)
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(join(assets, f), 'utf8'))
      .join('\n');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

test('vite build bakes a configured VITE_API_BASE into the bundle', () => {
  const js = buildBundleText(SENTINEL);
  assert.ok(
    js.includes(SENTINEL),
    'sentinel VITE_API_BASE value must appear in the built bundle'
  );
});

test('vite build without VITE_API_BASE carries no trace of it', () => {
  const js = buildBundleText(undefined);
  assert.ok(!js.includes('wiretest'), 'unset build must not contain the sentinel');
});
