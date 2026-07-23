import type { AccountUsageFetchResult } from '@vibecook/chopsticks-core';

/**
 * Grok Build 0.2.111 fetches its weekly quota through an in-process
 * `x.ai/billing` TUI extension. The same method is not registered on direct or
 * shared-leader ACP connections, so the adapter must not claim a structured
 * capability or scrape the terminal/credential cache.
 */
export async function fetchGrokAccountUsage(): Promise<AccountUsageFetchResult> {
  return {
    status: 'unsupported',
    provider: 'grok',
    message: 'Grok account usage is not exposed through its ACP/headless protocol',
    retryable: false,
  };
}
