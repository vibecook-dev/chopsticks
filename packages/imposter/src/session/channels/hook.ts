/**
 * Hook channel — claude's `type:"http"` and `type:"command"` handlers, read
 * from the generated settings file the adapter hands the vendor.
 *
 * Delivery failures are logged, never thrown: a hook the bridge rejects (or a
 * forwarder that can't spawn) must not kill the imposted process — the real
 * vendor's hooks fail the same soft way (draft/IMPOSTER.md §7.3 item 6).
 */

import { spawn } from 'node:child_process';

export interface HookSettings {
  hooks?: Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>>;
}

export interface HookEmitterOptions {
  /** Parsed claude-shape settings (the generated hooks file). */
  settings: HookSettings;
  /** Process env used to resolve `$VAR` header references. */
  env: Record<string, string | undefined>;
  log?: (message: string) => void;
}

export interface HookEmitter {
  /**
   * Deliver one event; resolves when the handler(s) acknowledge. `routeEvent`
   * is an imposter-only escape hatch for sending a future/unknown native name
   * through a known handler transport so ADR-008 retention can be tested end
   * to end.
   */
  emit(event: string, payload: Record<string, unknown>, routeEvent?: string): Promise<void>;
}

/** Resolve `Bearer $VAR`-style header values against explicitly granted env. */
function resolveEnvRefs(value: string, env: Record<string, string | undefined>, allowed: Set<string>): string {
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, name: string) =>
    allowed.has(name) ? (env[name] ?? match) : match,
  );
}

/**
 * The repo's own generated curl forwarder (settings.ts `curlForwarder`) is
 * recognized by shape and delivered as a direct POST with identical headers
 * and body. The observable contract at the bridge is byte-identical, but the
 * shortcut works where `sh` is absent (Windows dev machines); unrecognized
 * command handlers still run through the platform shell with the payload on
 * stdin (draft/IMPOSTER.md §7.3 item 4).
 */
const FORWARDER_SHAPE =
  /curl -s -m (\d+) -X POST -H "Content-Type: application\/json" -H "Authorization: Bearer \$([A-Z_][A-Z0-9_]*)" --data-binary @- ([^\s']+)/;

const DEFAULT_TIMEOUT_SEC = 5;
const MAX_TIMEOUT_SEC = 300;

function handlerTimeoutSec(handler: Record<string, unknown>): number {
  const configured = handler.timeout;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? Math.min(configured, MAX_TIMEOUT_SEC)
    : DEFAULT_TIMEOUT_SEC;
}

async function deliver(
  handler: Record<string, unknown>,
  payload: Record<string, unknown>,
  env: Record<string, string | undefined>,
  log: (message: string) => void,
): Promise<void> {
  const body = JSON.stringify(payload);
  if (handler.type === 'http') {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const allowedEnvVars = new Set(
      Array.isArray(handler.allowedEnvVars)
        ? handler.allowedEnvVars.filter((name): name is string => typeof name === 'string')
        : [],
    );
    for (const [name, value] of Object.entries((handler.headers as Record<string, string>) ?? {})) {
      headers[name] = resolveEnvRefs(value, env, allowedEnvVars);
    }
    const res = await fetch(String(handler.url), {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(handlerTimeoutSec(handler) * 1000),
    });
    if (res.status !== 200) log(`hook POST -> ${res.status}`);
    return;
  }
  if (handler.type === 'command' && typeof handler.command === 'string') {
    const forwarder = handler.command.match(FORWARDER_SHAPE);
    if (forwarder) {
      const [, timeout, tokenVar, url] = forwarder;
      const res = await fetch(url!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env[tokenVar!] ?? ''}` },
        body,
        signal: AbortSignal.timeout(Number(timeout) * 1000),
      });
      if (res.status !== 200) log(`forwarded hook POST -> ${res.status}`);
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      const child = spawn(handler.command as string, { shell: true, stdio: ['pipe', 'ignore', 'ignore'] });
      const timeoutSec = handlerTimeoutSec(handler);
      timer = setTimeout(() => {
        log(`command hook timed out after ${timeoutSec}s`);
        child.kill('SIGKILL');
        finish();
      }, timeoutSec * 1000);
      child.on('error', (error) => {
        log(`command hook failed to spawn: ${error.message}`);
        finish();
      });
      child.on('close', finish);
      child.stdin.on('error', (error) => log(`command hook stdin failed: ${error.message}`));
      child.stdin.end(body);
    });
  }
}

export function createHookEmitter(options: HookEmitterOptions): HookEmitter {
  const log = options.log ?? (() => {});
  // Hooks fire 1:1 with their cause and the bridge treats arrival order as
  // meaningful, so emissions are serialized on a promise chain.
  let queue = Promise.resolve();
  return {
    emit(event, payload, routeEvent = event) {
      const matchers = options.settings.hooks?.[routeEvent] ?? [];
      const handlers = matchers.flatMap((matcher) => matcher.hooks ?? []);
      if (handlers.length === 0) {
        log(`dropped unwired event ${event}`);
        return Promise.resolve();
      }
      const full = { ...payload, hook_event_name: event };
      queue = queue.then(() =>
        Promise.all(
          handlers.map((handler) =>
            deliver(handler, full, options.env, log).catch((error: unknown) => {
              log(`hook ${event} delivery failed: ${error instanceof Error ? error.message : String(error)}`);
            }),
          ),
        ).then(() => undefined),
      );
      return queue;
    },
  };
}
