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

describe('godviewTruffleConfig', () => {
  it('enables Truffle with stable development identity and state defaults', () => {
    const config = godviewTruffleConfig({
      ...base,
      environment: {},
      pathExists: (path) => path === '/project/p008/truffle/packages/sidecar-slim/sidecar-slim',
    });

    expect(config).toEqual({
      enabled: true,
      environment: {
        GHOSTTEA_TRUFFLE_ENABLED: 'true',
        GHOSTTEA_TRUFFLE_STATE_DIR: '/user/godview/truffle',
        GHOSTTEA_TRUFFLE_DEVICE_NAME: 'studio · Godview',
        TRUFFLE_SIDECAR_PATH: '/project/p008/truffle/packages/sidecar-slim/sidecar-slim',
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

  it('uses packaged and explicit sidecars and rejects a missing enabled sidecar', () => {
    const packaged = godviewTruffleConfig({
      ...base,
      isPackaged: true,
      environment: {},
      pathExists: (path) => path === '/application/resources/bin/sidecar-slim',
    });
    expect(packaged.environment.TRUFFLE_SIDECAR_PATH).toBe('/application/resources/bin/sidecar-slim');

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
