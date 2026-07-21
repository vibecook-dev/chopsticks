import { constants, accessSync } from 'node:fs';
import { createConnection } from 'node:net';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

type Agent = 'claude' | 'codex' | 'grok';

interface ExecResponse {
  action: 'exec';
  preparationId: string;
  launch: { command: string; args: string[]; cwd: string; env?: Record<string, string> };
}

type Response = ExecResponse | { action: 'fallback'; reason: string } | { action: 'ack' };

const shimPath = resolve(process.argv[1]!);
const shimDirectory = dirname(shimPath);
const agent = shimPath.split('/').at(-1) as Agent;
const originalArgv = process.argv.slice(2);
const originalCwd = process.cwd();

function cleanPath(): string {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry && resolve(entry) !== shimDirectory)
    .join(delimiter);
}

function executableOnPath(name: string, pathValue: string): string | undefined {
  if (isAbsolute(name)) return name;
  for (const directory of pathValue.split(delimiter)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (resolve(candidate) !== shimPath) return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}

function execEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === 'string') environment[name] = value;
  }
  Object.assign(environment, extra);
  environment.PATH = cleanPath();
  const originalZDotDirectory = environment.CHOPSTICKS_ORIGINAL_ZDOTDIR;
  if (originalZDotDirectory) environment.ZDOTDIR = originalZDotDirectory;
  else delete environment.ZDOTDIR;
  delete environment.CHOPSTICKS_SPAWN_PORT;
  delete environment.CHOPSTICKS_SPAWN_TOKEN;
  delete environment.CHOPSTICKS_SHIM_DIR;
  delete environment.CHOPSTICKS_ORIGINAL_ZDOTDIR;
  return environment;
}

function exec(command: string, args: string[], cwd: string, extraEnvironment?: Record<string, string>): never {
  const environment = execEnvironment(extraEnvironment);
  const executable = executableOnPath(command, environment.PATH) ?? command;
  process.chdir(cwd);
  const execve = process.execve;
  if (!execve) throw new Error('this Node.js version does not provide process.execve');
  execve(executable, [executable, ...args], environment);
  throw new Error('process.execve returned without replacing the shim process');
}

function fallback(realExecutable: string): never {
  try {
    exec(realExecutable, originalArgv, originalCwd);
  } catch (error) {
    process.stderr.write(
      `chopsticks: could not launch ${agent}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(127);
  }
}

function request(payload: object): Promise<Response> {
  const port = Number(process.env.CHOPSTICKS_SPAWN_PORT);
  const token = process.env.CHOPSTICKS_SPAWN_TOKEN;
  if (!Number.isSafeInteger(port) || port <= 0 || !token) return Promise.reject(new Error('gateway unavailable'));
  return new Promise<Response>((resolveResponse, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let response = '';
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else {
        try {
          resolveResponse(JSON.parse(response.trim()) as Response);
        } catch (cause) {
          reject(cause);
        }
      }
    };
    socket.setEncoding('utf8');
    socket.setTimeout(28_000, () => finish(new Error('gateway timed out')));
    socket.once('connect', () => socket.write(`${JSON.stringify({ ...payload, token })}\n`));
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (response.includes('\n')) finish();
    });
    socket.once('error', (error) => finish(error));
    socket.once('end', () => {
      if (!settled) finish(response.trim() ? undefined : new Error('gateway closed without a response'));
    });
  });
}

async function main(): Promise<never> {
  const realExecutable = executableOnPath(agent, cleanPath());
  if (!realExecutable) {
    process.stderr.write(`chopsticks: ${agent} is not installed outside the Workbench shim path\n`);
    process.exit(127);
  }
  if (!['claude', 'codex', 'grok'].includes(agent)) return fallback(realExecutable);
  try {
    const response = await request({
      type: 'launch',
      agent,
      cwd: originalCwd,
      argv: originalArgv,
      pid: process.pid,
      parentPid: process.ppid,
    });
    if (response.action !== 'exec') return fallback(realExecutable);
    try {
      exec(response.launch.command, response.launch.args, response.launch.cwd, response.launch.env);
    } catch (error) {
      await request({
        type: 'exec-failed',
        preparationId: response.preparationId,
        message: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      process.chdir(originalCwd);
      return fallback(realExecutable);
    }
  } catch {
    return fallback(realExecutable);
  }
}

void main();
