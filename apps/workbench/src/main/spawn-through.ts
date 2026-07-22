import { createServer, type Server, type Socket } from 'node:net';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type {
  AdoptPreparedSessionResult,
  AgentRuntime,
  BuiltinExecutableAgentKind,
  CreateAgentSessionOptions,
  PreparedAgentSessionInfo,
} from '@vibecook/chopsticks-runtime';

const MAX_REQUEST_BYTES = 64 * 1024;

export interface SpawnThroughLaunchRequest {
  type: 'launch';
  token: string;
  agent: BuiltinExecutableAgentKind;
  cwd: string;
  argv: string[];
  pid: number;
  parentPid: number;
}

export interface SpawnThroughExecFailedRequest {
  type: 'exec-failed';
  token: string;
  preparationId: string;
  message: string;
}

export type SpawnThroughRequest = SpawnThroughLaunchRequest | SpawnThroughExecFailedRequest;

export type SpawnThroughResponse =
  | {
      action: 'exec';
      preparationId: string;
      launch: PreparedAgentSessionInfo['launch'];
    }
  | { action: 'fallback'; reason: string }
  | { action: 'ack' };

export interface AdoptedSpawnThroughSession {
  info: Exclude<AdoptPreparedSessionResult, { error: unknown }>;
  session: SessionSummary;
  processId: number;
  preparationId: string;
}

export interface PrepareSpawnThroughDependencies {
  runtime: Pick<AgentRuntime, 'prepareSession' | 'adoptPrepared' | 'cancelPrepared'>;
  listSessions(): Promise<SessionSummary[]>;
  onAdopted(adopted: AdoptedSpawnThroughSession): void | Promise<void>;
}

function positivePid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ParsedInvocation = Pick<CreateAgentSessionOptions, 'resume' | 'agentOptions'>;

/** Translate only argv forms whose semantics adapters can preserve exactly. */
export function parseSpawnThroughInvocation(
  agent: BuiltinExecutableAgentKind,
  argv: readonly string[],
): ParsedInvocation | { error: string } {
  if (argv.length === 0) return {};

  if (agent === 'claude') {
    if ((argv[0] === '--continue' || argv[0] === '-c') && argv.length === 1) {
      return { agentOptions: { resumeInvocation: [...argv] } };
    }
    if ((argv[0] === '--resume' || argv[0] === '-r') && argv.length <= 2) {
      const selection = argv[1];
      return selection && UUID.test(selection)
        ? { resume: selection }
        : { agentOptions: { resumeInvocation: [...argv] } };
    }
  }

  if (agent === 'codex' && argv[0] === 'resume') {
    if (argv.some((argument) => argument === '--remote' || argument === '--remote-auth-token-env')) {
      return { error: 'Codex remote transport arguments are owned by Chopsticks' };
    }
    if (argv.length === 2 && UUID.test(argv[1]!)) return { resume: argv[1] };
    return { agentOptions: { resumeInvocation: [...argv] } };
  }

  if (agent === 'grok') {
    if ((argv[0] === '--continue' || argv[0] === '-c') && argv.length === 1) {
      return { agentOptions: { resumeLatest: true } };
    }
    if ((argv[0] === '--resume' || argv[0] === '-r') && argv.length <= 2) {
      return argv[1] ? { resume: argv[1] } : { agentOptions: { resumeLatest: true } };
    }
  }

  return { error: 'custom arguments are not spawn-through compatible' };
}

export function matchingTerminalSession(
  sessions: readonly SessionSummary[],
  request: Pick<SpawnThroughLaunchRequest, 'pid' | 'parentPid'>,
): SessionSummary | undefined {
  const live = sessions.filter((session) => !session.exited && session.pid !== null);
  return (
    live.find((session) => session.pid === request.parentPid) ?? live.find((session) => session.pid === request.pid)
  );
}

export async function prepareSpawnThroughLaunch(
  request: SpawnThroughLaunchRequest,
  dependencies: PrepareSpawnThroughDependencies,
): Promise<SpawnThroughResponse> {
  if (!positivePid(request.pid) || !positivePid(request.parentPid)) {
    return { action: 'fallback', reason: 'invalid process identity' };
  }
  if (!request.cwd || !Array.isArray(request.argv) || request.argv.some((argument) => typeof argument !== 'string')) {
    return { action: 'fallback', reason: 'invalid launch request' };
  }
  const invocation = parseSpawnThroughInvocation(request.agent, request.argv);
  if ('error' in invocation) return { action: 'fallback', reason: invocation.error };

  const session = matchingTerminalSession(await dependencies.listSessions(), request);
  if (!session) return { action: 'fallback', reason: 'containing Ghosttea terminal was not found' };

  const prepared = await dependencies.runtime.prepareSession({
    agent: request.agent,
    cwd: request.cwd,
    ...invocation,
  });
  if ('error' in prepared) return { action: 'fallback', reason: prepared.error.message };

  const adopted = await dependencies.runtime.adoptPrepared(prepared.preparationId, {
    runtimeSessionId: session.id,
    processId: request.pid,
  });
  if ('error' in adopted) {
    await dependencies.runtime.cancelPrepared(prepared.preparationId);
    return { action: 'fallback', reason: adopted.error.message };
  }

  await dependencies.onAdopted({
    info: adopted,
    session,
    processId: request.pid,
    preparationId: prepared.preparationId,
  });
  return { action: 'exec', preparationId: prepared.preparationId, launch: prepared.launch };
}

export interface SpawnThroughGateway {
  port: number;
  close(): Promise<void>;
}

function writeResponse(socket: Socket, response: SpawnThroughResponse): void {
  if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
}

export async function startSpawnThroughGateway(
  token: string,
  handle: (request: SpawnThroughRequest) => Promise<SpawnThroughResponse>,
): Promise<SpawnThroughGateway> {
  const server: Server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.setTimeout(30_000, () => socket.destroy());
    let input = '';
    let handled = false;
    socket.on('data', (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
        handled = true;
        writeResponse(socket, { action: 'fallback', reason: 'spawn-through request is too large' });
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      void (async () => {
        try {
          const request = JSON.parse(input.slice(0, newline)) as SpawnThroughRequest;
          if (!request || request.token !== token) {
            writeResponse(socket, { action: 'fallback', reason: 'spawn-through authentication failed' });
            return;
          }
          writeResponse(socket, await handle(request));
        } catch (error) {
          writeResponse(socket, {
            action: 'fallback',
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('spawn-through gateway did not bind a TCP port');
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
