import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { godviewTruffleConfig } from './truffle-config.js';

const base = {
  appRoot: '/project/p008/chopsticks/apps/godview',
  isPackaged: false,
  resourcesPath: '/application/resources',
  userDataPath: '/user/godview',
  platform: 'darwin' as const,
  hostname: 'studio',
};
const developmentSidecar = join(base.appRoot, 'dist', 'bin', 'sidecar-slim');
const bundledSidecar = join(base.resourcesPath, 'bin', 'sidecar-slim');

describe('godviewTruffleConfig', () => {
  it('enables Truffle with stable development identity and state defaults', () => {
    const config = godviewTruffleConfig({
      ...base,
      environment: {},
      pathExists: (path) => path === developmentSidecar,
    });

    expect(config).toEqual({
      enabled: true,
      environment: {
        GHOSTTEA_TRUFFLE_ENABLED: 'true',
        GHOSTTEA_TRUFFLE_STATE_DIR: join(base.userDataPath, 'truffle'),
        GHOSTTEA_TRUFFLE_DEVICE_NAME: 'studio · Godview',
        TRUFFLE_SIDECAR_PATH: developmentSidecar,
      },
    });
  });

  it('honors the local-only override without requiring a sidecar', () => {
    const config = godviewTruffleConfig({
      ...base,
      environment: { TERMINALD_TRUFFLE_ENABLED: 'off' },
      pathExists: () => false,
    });

    expect(config.enabled).toBe(false);
    expect(config.environment.GHOSTTEA_TRUFFLE_ENABLED).toBe('off');
    expect(config.environment.TRUFFLE_SIDECAR_PATH).toBeUndefined();
  });

  it('can default Truffle off for hermetic smoke runs', () => {
    const config = godviewTruffleConfig({
      ...base,
      enabledByDefault: false,
      environment: {},
      pathExists: () => false,
    });

    expect(config.enabled).toBe(false);
    expect(config.environment.GHOSTTEA_TRUFFLE_ENABLED).toBe('false');
  });

  it('uses packaged and explicit sidecars and rejects a missing enabled sidecar', () => {
    const packaged = godviewTruffleConfig({
      ...base,
      isPackaged: true,
      environment: {},
      pathExists: (path) => path === bundledSidecar,
    });
    expect(packaged.environment.TRUFFLE_SIDECAR_PATH).toBe(bundledSidecar);

    const explicit = godviewTruffleConfig({
      ...base,
      environment: { TRUFFLE_SIDECAR_PATH: '/custom/sidecar' },
      pathExists: (path) => path === '/custom/sidecar',
    });
    expect(explicit.environment.TRUFFLE_SIDECAR_PATH).toBe('/custom/sidecar');

    expect(() =>
      godviewTruffleConfig({ ...base, environment: {}, pathExists: () => false }),
    ).toThrow(/Truffle is enabled but sidecar-slim was not found/);
  });
});
