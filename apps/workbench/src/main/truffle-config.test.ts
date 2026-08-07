import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workbenchTruffleConfig } from './truffle-config.js';

const base = {
  appRoot: '/project/p008/chopsticks/apps/workbench',
  isPackaged: false,
  resourcesPath: '/application/resources',
  userDataPath: '/user/chopsticks',
  platform: 'darwin' as const,
  hostname: 'studio',
};
const developmentSidecar = join(base.appRoot, 'dist', 'bin', 'sidecar-slim');
const bundledSidecar = join(base.resourcesPath, 'bin', 'sidecar-slim');

describe('workbenchTruffleConfig', () => {
  it('enables Truffle with stable development identity and state defaults', () => {
    const config = workbenchTruffleConfig({
      ...base,
      environment: {},
      pathExists: (path) => path === developmentSidecar,
    });

    expect(config).toEqual({
      enabled: true,
      environment: {
        GHOSTTEA_TRUFFLE_ENABLED: 'true',
        GHOSTTEA_TRUFFLE_STATE_DIR: join(base.userDataPath, 'truffle'),
        GHOSTTEA_TRUFFLE_DEVICE_NAME: 'studio · Chopsticks',
        TRUFFLE_SIDECAR_PATH: developmentSidecar,
      },
    });
  });

  it('honors the local-only override without requiring a sidecar', () => {
    const config = workbenchTruffleConfig({
      ...base,
      environment: { TERMINALD_TRUFFLE_ENABLED: 'off' },
      pathExists: () => false,
    });

    expect(config.enabled).toBe(false);
    expect(config.environment.GHOSTTEA_TRUFFLE_ENABLED).toBe('off');
    expect(config.environment.TRUFFLE_SIDECAR_PATH).toBeUndefined();
  });

  it('can default Truffle off for hermetic smoke runs', () => {
    const config = workbenchTruffleConfig({
      ...base,
      enabledByDefault: false,
      environment: {},
      pathExists: () => false,
    });

    expect(config.enabled).toBe(false);
    expect(config.environment.GHOSTTEA_TRUFFLE_ENABLED).toBe('false');
  });

  it('uses packaged and explicit sidecars and rejects a missing enabled sidecar', () => {
    const packaged = workbenchTruffleConfig({
      ...base,
      isPackaged: true,
      environment: {},
      pathExists: (path) => path === bundledSidecar,
    });
    expect(packaged.environment.TRUFFLE_SIDECAR_PATH).toBe(bundledSidecar);

    const explicit = workbenchTruffleConfig({
      ...base,
      environment: { TRUFFLE_SIDECAR_PATH: '/custom/sidecar' },
      pathExists: (path) => path === '/custom/sidecar',
    });
    expect(explicit.environment.TRUFFLE_SIDECAR_PATH).toBe('/custom/sidecar');

    expect(() =>
      workbenchTruffleConfig({ ...base, environment: {}, pathExists: () => false }),
    ).toThrow(/Truffle is enabled but sidecar-slim was not found/);
  });
});
