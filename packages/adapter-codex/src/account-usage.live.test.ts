/**
 * Read-only opt-in coverage of the real authenticated Codex app-server.
 *
 *   CODEX_ACCOUNT_USAGE_LIVE=1 pnpm exec vitest run src/account-usage.live.test.ts
 */

import { describe, expect, it } from 'vitest';
import { fetchCodexAccountUsage } from './account-usage.js';

const live = process.env.CODEX_ACCOUNT_USAGE_LIVE === '1';

describe.skipIf(!live)('Codex account usage (live)', () => {
  it('returns at least one duration-labelled metered window', async () => {
    const result = await fetchCodexAccountUsage({ requestTimeoutMs: 20_000 });
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;

    expect(result.snapshot.provider).toBe('codex');
    expect(result.snapshot.limits.length).toBeGreaterThan(0);
    const windows = result.snapshot.limits.flatMap((limit) => limit.windows);
    expect(windows.length).toBeGreaterThan(0);
    for (const window of windows) {
      expect(window.usedPercent).toBeGreaterThanOrEqual(0);
      if (window.durationMinutes !== undefined) expect(window.durationMinutes).toBeGreaterThan(0);
      if (window.resetsAt !== undefined) expect(Number.isFinite(Date.parse(window.resetsAt))).toBe(true);
    }
  }, 25_000);
});
