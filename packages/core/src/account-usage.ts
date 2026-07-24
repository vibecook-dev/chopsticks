/**
 * Provider-neutral account usage and quota contracts.
 *
 * Account limits are deliberately separate from AgentSession: subscription
 * quotas are normally shared by every process and conversation authenticated as
 * the same provider account.
 */

export type AccountUsageScope = 'subscription' | 'api' | 'workspace' | 'unknown';

export interface AccountUsageSource {
  /** How the adapter obtained the snapshot without exposing credentials. */
  kind: 'native-protocol' | 'native-statusline' | 'oauth-endpoint';
  /** Whether the provider publicly documents this integration surface. */
  stability: 'documented' | 'experimental';
}

export interface AccountUsageWindow {
  /** Provider-stable identifier such as `primary`, `five_hour`, or `seven_day_opus`. */
  id: string;
  /** Optional display label supplied or derived by the adapter. */
  label?: string;
  /** Window length when the provider reports it or its identifier defines it. */
  durationMinutes?: number;
  /** Inclusive period start, normalized to ISO 8601 when available. */
  startsAt?: string;
  /** Next reset/period end, normalized to ISO 8601 when available. */
  resetsAt?: string;
  /** Percentage consumed. Adapters preserve the provider's value rather than estimating tokens. */
  usedPercent?: number;
}

export interface AccountUsageCredits {
  /** Provider-formatted balance. Kept as a string to avoid losing decimal precision. */
  balance?: string;
  hasCredits?: boolean;
  unlimited?: boolean;
  /** Available provider-issued rate-limit reset credits, when supported. */
  resetCreditsAvailable?: number;
}

export interface AccountUsageBudget {
  /** Provider-formatted total allowance. Kept as a string to preserve units and decimal precision. */
  limit?: string;
  /** Provider-formatted amount consumed. Kept as a string to preserve units and decimal precision. */
  used?: string;
  /** Percentage still available when reported directly by the provider. */
  remainingPercent?: number;
  /** Budget renewal or expiry, normalized to ISO 8601 when available. */
  resetsAt?: string;
  /** Provider-reported exhaustion state. */
  reached?: boolean;
}

export interface AccountUsageLimit {
  /** Provider-stable metered bucket identifier. */
  id: string;
  name?: string;
  plan?: string;
  /** Provider-reported lifecycle or availability state for optional limits. */
  status?: string;
  /** Provider-classified reached/depleted state. */
  reached?: string;
  /** Whether an optional/overage quota is enabled for this account. */
  enabled?: boolean;
  windows: readonly AccountUsageWindow[];
  credits?: AccountUsageCredits;
  /** Absolute spend, credit, or allocation cap associated with this limit. */
  budget?: AccountUsageBudget;
}

export interface AccountUsageSnapshot {
  provider: string;
  fetchedAt: string;
  scope: AccountUsageScope;
  source: AccountUsageSource;
  limits: readonly AccountUsageLimit[];
  /** Account-wide credits that are not owned by one metered bucket. */
  credits?: AccountUsageCredits;
}

export interface AccountUsageAvailable {
  status: 'available';
  snapshot: AccountUsageSnapshot;
}

export interface AccountUsageFailure {
  status: 'unsupported' | 'unauthenticated' | 'unavailable';
  provider: string;
  message: string;
  retryable: boolean;
  code?: 'rate-limited';
  /** Earliest provider-authorized retry time, normalized from Retry-After when available. */
  retryAt?: string;
}

export type AccountUsageFetchResult = AccountUsageAvailable | AccountUsageFailure;
