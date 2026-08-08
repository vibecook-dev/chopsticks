/**
 * Server-request responses, per the vendor's own generated schema
 * (`codex app-server generate-json-schema`, verified against codex-cli
 * 0.147.0 on 2026-08-07).
 *
 * `CodexApprovalDecision` ('approved' | 'denied') stays the ABSTRACT contract
 * callers program against. What changed is that it is no longer written to the
 * wire verbatim: codex has four different response shapes across its eleven
 * server requests, and the abstract word is valid in almost none of them.
 *
 *   'approved' is legal on 2 of 11 — the deprecated `execCommandApproval` /
 *   `applyPatchApproval` pair, via `ReviewDecision`.
 *   'denied' is legal on ZERO. The legacy pair spells denial as the OBJECT
 *   `{denied:{rejection}}`; the current pair spells it `"decline"`.
 *
 * Since the default with no `onApproval` handler is to deny, the adapter's
 * out-of-the-box answer to any approval was malformed on every method. It was
 * never caught because the one captured session used `approvalPolicy:'never'`,
 * so no approval ever arrived — the gap was marked UNVERIFIED in driver.ts and
 * is settled here.
 */

import type { CodexApprovalDecision } from './driver.js';

/**
 * Legacy pair answering with `ReviewDecision`. Deprecated upstream but still
 * present in 0.147.0, and still what an older app-server sends.
 */
const REVIEW_DECISION_METHODS = new Set(['execCommandApproval', 'applyPatchApproval']);

/** Current approval pair answering with an accept/decline decision. */
const ACCEPT_DECLINE_METHODS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);

/**
 * Server requests that are NOT approvals: they ask the client to supply a
 * capability (an attestation token, refreshed auth tokens, tool output, user
 * input). Answering them with an approval decision produces a well-formed
 * JSON-RPC response carrying a body the server cannot parse — worse than an
 * error, because it looks like success. The adapter does not implement these,
 * so it must say so (see `approvalResponse` throwing).
 */
const CAPABILITY_METHODS = new Set([
  'item/tool/call',
  'item/tool/requestUserInput',
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
  'attestation/generate',
  'account/chatgptAuthTokens/refresh',
  'currentTime/read',
]);

export function isApprovalRequest(method: string): boolean {
  return REVIEW_DECISION_METHODS.has(method) || ACCEPT_DECLINE_METHODS.has(method);
}

export class UnsupportedServerRequestError extends Error {
  constructor(method: string) {
    super(
      `codex server request ${method} is not implemented by this client; ` +
        `answering it with an approval decision would send an unparseable body`,
    );
    this.name = 'UnsupportedServerRequestError';
  }
}

/**
 * Translate the abstract decision into the exact body this method expects.
 * Throws for anything that is not an approval, so the transport answers with a
 * JSON-RPC error rather than a plausible-looking wrong result.
 */
export function approvalResponse(
  method: string,
  decision: CodexApprovalDecision,
  rejection = 'denied by chopsticks policy',
): Record<string, unknown> {
  if (REVIEW_DECISION_METHODS.has(method)) {
    return decision === 'approved' ? { decision: 'approved' } : { decision: { denied: { rejection } } };
  }
  if (ACCEPT_DECLINE_METHODS.has(method)) {
    return { decision: decision === 'approved' ? 'accept' : 'decline' };
  }
  throw new UnsupportedServerRequestError(method);
}

/** Every server request the schema declares, for tests and diagnostics. */
export const KNOWN_SERVER_REQUESTS: readonly string[] = [
  ...REVIEW_DECISION_METHODS,
  ...ACCEPT_DECLINE_METHODS,
  ...CAPABILITY_METHODS,
];
