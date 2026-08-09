/**
 * The serve table (draft/IMPOSTER.md §9.3): what the imposter answers, as data.
 *
 * A JSON-RPC vendor has ~95 client-request methods, but the imposter only has
 * to be a good enough app-server for OUR adapter — 8 methods, all discoverable
 * by reading the driver. Projecting the other 87 onto a 10-op vocabulary would
 * be a category error: they are an RPC service surface, not agent semantics.
 *
 * Three properties this file exists to hold, none of which fit the op timeline:
 *
 *  - **A state machine.** Codex enforces `initialize` first and answers
 *    -32600 "Not initialized" to everything before it, so the imposter has a
 *    gate the timeline has no place to keep.
 *  - **A synchronous reply.** `run()` returns `Promise<void>`; a served method
 *    must return a value.
 *  - **`then` schedules ops, and NEVER writes the wire.** That is what keeps
 *    §2's "the screen cannot contradict the wire" true: everything observable
 *    still originates from one op, even when an RPC caused it.
 */

import type { OpInvocation, Persona } from '../persona/types.ts';
import { INVALID_PARAMS, METHOD_NOT_FOUND, RpcError } from './channels/jsonrpc.ts';
import { substitute } from './template.ts';

export interface ServeGate {
  /** Method that opens the gate; everything before it gets `error`. */
  until: string;
  error: { code: number; message: string };
}

export interface ServeEntry {
  /**
   * Session bindings minted before the result is built, so the id in the reply
   * and the id in the ops that follow are the same value rather than two
   * independent draws from `$uuid:`.
   */
  bind?: Record<string, string>;
  result?: unknown;
  /** Ops to run AFTER the reply is written — the vendor replies, then streams. */
  then?: OpInvocation[] | '$behavior';
}

export interface ServeServer {
  gate?: ServeGate;
  /**
   * The vendor subcommand that turns this binary into a server — `codex
   * app-server`. Without it the invocation is interactive, exactly as the real
   * CLI behaves, so `ai --codex` opens a screen and `ai --codex app-server`
   * speaks the protocol.
   */
  command?: string;
}

export interface ServeDocument {
  $server?: ServeServer;
  [method: string]: ServeEntry | ServeServer | undefined;
}

export interface ServeDispatcherOptions {
  persona: Persona;
  document: ServeDocument;
  /** Session bindings; `bind` writes into this object so ops see the same values. */
  bindings: Record<string, unknown>;
  runOps(invocations: readonly OpInvocation[]): Promise<void>;
  /** The persona's behavior pack, for `then: "$behavior"`. */
  runBehavior(stimulus: Record<string, unknown>): Promise<void>;
  validateParams?(method: string, params: Record<string, unknown>): string[];
  log?(message: string): void;
}

export interface ServeDispatcher {
  /** Answer one client request. Throws `RpcError` for anything refusable. */
  serve(method: string, params: Record<string, unknown>): Promise<unknown>;
  notified(method: string, params: Record<string, unknown>): void;
  readonly opened: boolean;
}

const isEntry = (value: unknown): value is ServeEntry => value !== null && typeof value === 'object';

/**
 * Pull the turn's prompt text out of `turn/start`. The adapter sends
 * `input: [{ type: 'text', text }]`, and the behavior pack wants `$stimulus.text`.
 */
function stimulusFrom(params: Record<string, unknown>): Record<string, unknown> {
  const input = params.input;
  if (!Array.isArray(input)) return {};
  const text = input
    .map((entry) => (entry !== null && typeof entry === 'object' ? (entry as { text?: unknown }).text : undefined))
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return text ? { text } : {};
}

export function createServeDispatcher(options: ServeDispatcherOptions): ServeDispatcher {
  const log = options.log ?? (() => {});
  const gate = options.document.$server?.gate;
  let opened = gate === undefined;

  const serve = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (!opened && gate && method !== gate.until) {
      throw new RpcError(gate.error.code, gate.error.message);
    }

    const entry = options.document[method];
    if (!isEntry(entry) || method === '$server') {
      // Refusing loudly is the point: the imposter is a conformance test of
      // the adapter's CLIENT, a capability the hook family structurally cannot
      // have (§9.3 non-negotiable 2).
      throw new RpcError(METHOD_NOT_FOUND, `imposter does not serve ${method}`);
    }

    // Inbound params are validated against the ASM exactly like outbound
    // payloads. A violation is an error reply, never a crash.
    const violations = options.validateParams?.(method, params) ?? [];
    if (violations.length > 0) {
      throw new RpcError(INVALID_PARAMS, `${method}: ${violations.join('; ')}`);
    }

    const stimulus = stimulusFrom(params);
    const context = () => ({ scopes: { params, stimulus }, bindings: options.bindings });

    for (const [name, template] of Object.entries(entry.bind ?? {})) {
      options.bindings[name] = substitute(template, { ...context(), uuids: new Map() });
    }

    const result = entry.result === undefined ? {} : substitute(entry.result, context());
    if (method === gate?.until) opened = true;

    // `then` must run after the REPLY IS WRITTEN, not merely after this
    // function returns. `queueMicrotask` is not enough: the write happens in
    // the continuation after `await serve()`, and a microtask scheduled here
    // runs before that continuation — which put `thread/started` on the wire
    // ahead of the `thread/start` result, announcing a thread the client had
    // not been told about. `setImmediate` is a macrotask and lands after.
    const follow = entry.then;
    if (follow !== undefined) {
      setImmediate(() => {
        const work = follow === '$behavior' ? options.runBehavior(stimulus) : options.runOps(follow as OpInvocation[]);
        void work.catch((error: unknown) => {
          log(`serve ${method} follow-up failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      });
    }
    return result;
  };

  return {
    serve,
    notified(method) {
      if (gate && method === gate.until) opened = true;
      log(`notified ${method}`);
    },
    get opened() {
      return opened;
    },
  };
}
