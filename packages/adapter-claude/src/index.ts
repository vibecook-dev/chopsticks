/**
 * @vibecook/chopsticks-adapter-claude — Claude Code native adapter
 * (DESIGN §16): hook-event registry, loopback hook bridge, and the
 * hook → AgentEvent normalizer. Detection, settings generation, and the
 * native driver build on these.
 */

export * from './registry.js';
export * from './hook-bridge.js';
export * from './normalizer.js';
export * from './detection.js';
export * from './settings.js';
export * from './prepare.js';
export * from './transcript-observer.js';
export * from './statusline.js';
export {
  CLAUDE_OAUTH_BETA,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_TOKEN_ENDPOINT,
  CLAUDE_USAGE_ENDPOINT,
  claudeAccountUsageFromStatusLine,
  fetchClaudeAccountUsage,
  getClaudeStatusLineAccountUsage,
  normalizeClaudeAccountUsage,
  observeClaudeStatusLineAccountUsage,
  onClaudeAccountUsage,
  type FetchClaudeAccountUsageOptions,
} from './account-usage.js';
export * from './prompt.js';
export * from './driver.js';
