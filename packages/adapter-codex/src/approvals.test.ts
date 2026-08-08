import { describe, expect, it } from 'vitest';
import {
  approvalResponse,
  isApprovalRequest,
  KNOWN_SERVER_REQUESTS,
  UnsupportedServerRequestError,
} from './approvals.js';

/**
 * Vocabularies verified against `codex app-server generate-json-schema`
 * (codex-cli 0.147.0). The point of these tests is that the abstract
 * 'approved' | 'denied' never reaches the wire unchanged.
 */
describe('approvalResponse', () => {
  it('answers the legacy pair with ReviewDecision', () => {
    for (const method of ['execCommandApproval', 'applyPatchApproval']) {
      expect(approvalResponse(method, 'approved')).toEqual({ decision: 'approved' });
      // Denial is an OBJECT here, with a required `rejection` — the bare string
      // 'denied' is not a member of ReviewDecision at all.
      expect(approvalResponse(method, 'denied')).toEqual({
        decision: { denied: { rejection: 'denied by chopsticks policy' } },
      });
    }
  });

  it('answers the current pair with accept/decline', () => {
    for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
      expect(approvalResponse(method, 'approved')).toEqual({ decision: 'accept' });
      expect(approvalResponse(method, 'denied')).toEqual({ decision: 'decline' });
    }
  });

  it('never emits the abstract words on the wire', () => {
    const bodies = KNOWN_SERVER_REQUESTS.filter(isApprovalRequest).flatMap((method) => [
      JSON.stringify(approvalResponse(method, 'approved')),
      JSON.stringify(approvalResponse(method, 'denied')),
    ]);
    // 'approved' survives only where ReviewDecision genuinely defines it.
    expect(bodies.filter((body) => body.includes('"denied":{'))).toHaveLength(2);
    expect(bodies.filter((body) => body === '{"decision":"denied"}')).toHaveLength(0);
  });

  it('refuses non-approval server requests rather than sending a wrong body', () => {
    // These ask the client for a capability (tool output, user input, tokens).
    // A `{decision}` reply would be well-formed JSON-RPC carrying a body the
    // server cannot parse — an error is the honest answer.
    for (const method of ['item/tool/call', 'attestation/generate', 'mcpServer/elicitation/request']) {
      expect(isApprovalRequest(method)).toBe(false);
      expect(() => approvalResponse(method, 'approved')).toThrow(UnsupportedServerRequestError);
    }
  });

  it('treats an unknown method as unsupported, not as an approval', () => {
    expect(() => approvalResponse('some/future/request', 'denied')).toThrow(UnsupportedServerRequestError);
  });

  it('carries a caller-supplied rejection reason into the legacy denial', () => {
    expect(approvalResponse('execCommandApproval', 'denied', 'sandbox is read-only')).toEqual({
      decision: { denied: { rejection: 'sandbox is read-only' } },
    });
  });
});
