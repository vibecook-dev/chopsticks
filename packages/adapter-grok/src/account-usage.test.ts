import { describe, expect, it } from 'vitest';
import { fetchGrokAccountUsage } from './account-usage.js';

describe('Grok account usage', () => {
  it('reports the missing public protocol capability explicitly', async () => {
    await expect(fetchGrokAccountUsage()).resolves.toEqual({
      status: 'unsupported',
      provider: 'grok',
      message: 'Grok account usage is not exposed through its ACP/headless protocol',
      retryable: false,
    });
  });
});
