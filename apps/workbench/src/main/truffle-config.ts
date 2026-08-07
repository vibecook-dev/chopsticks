import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export interface WorkbenchTruffleConfigOptions {
  appRoot: string;
  isPackaged: boolean;
  resourcesPath: string;
  userDataPath: string;
  platform: NodeJS.Platform;
  enabledByDefault?: boolean;
  environment?: NodeJS.ProcessEnv;
  pathExists?: (path: string) => boolean;
  hostname?: string;
}

export interface WorkbenchTruffleConfig {
  enabled: boolean;
  environment: Record<string, string>;
}

function nonempty(environment: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function booleanSetting(value: string): boolean {
  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      throw new Error('GHOSTTEA_TRUFFLE_ENABLED must be a boolean');
  }
}

/** Build the managed daemon's Truffle grant from the same flag that controls the renderer's remote-session UI. */
export function workbenchTruffleConfig(options: WorkbenchTruffleConfigOptions): WorkbenchTruffleConfig {
  const environment = options.environment ?? process.env;
  const pathExists = options.pathExists ?? existsSync;
  const enabledSetting =
    nonempty(environment, 'GHOSTTEA_TRUFFLE_ENABLED', 'TERMINALD_TRUFFLE_ENABLED') ??
    String(options.enabledByDefault ?? true);
  const enabled = booleanSetting(enabledSetting);
  const sidecarName = options.platform === 'win32' ? 'sidecar-slim.exe' : 'sidecar-slim';
  const bundledSidecar = join(options.resourcesPath, 'bin', sidecarName);
  const developmentSidecar = join(options.appRoot, 'dist', 'bin', sidecarName);
  const explicitSidecar = nonempty(environment, 'TRUFFLE_SIDECAR_PATH');
  const discoveredSidecar = options.isPackaged ? bundledSidecar : developmentSidecar;
  const sidecarPath = explicitSidecar ?? (pathExists(discoveredSidecar) ? discoveredSidecar : undefined);

  if (enabled && (!sidecarPath || !pathExists(sidecarPath))) {
    throw new Error(
      `Truffle is enabled but sidecar-slim was not found; set TRUFFLE_SIDECAR_PATH or install it at ${discoveredSidecar}`,
    );
  }

  return {
    enabled,
    environment: {
      GHOSTTEA_TRUFFLE_ENABLED: enabledSetting,
      GHOSTTEA_TRUFFLE_STATE_DIR:
        nonempty(environment, 'GHOSTTEA_TRUFFLE_STATE_DIR', 'TERMINALD_TRUFFLE_STATE_DIR') ??
        join(options.userDataPath, 'truffle'),
      GHOSTTEA_TRUFFLE_DEVICE_NAME:
        nonempty(environment, 'GHOSTTEA_TRUFFLE_DEVICE_NAME', 'TERMINALD_TRUFFLE_DEVICE_NAME') ??
        `${options.hostname ?? hostname()} · Chopsticks`,
      ...(sidecarPath ? { TRUFFLE_SIDECAR_PATH: sidecarPath } : {}),
    },
  };
}
