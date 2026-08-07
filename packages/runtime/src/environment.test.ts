import { describe, expect, it } from 'vitest';
import { buildAgentEnvironment } from './environment.js';

describe('buildAgentEnvironment', () => {
  it('win32 grants carry SystemRoot and user dirs (clean-env ConPTY aborts without them)', () => {
    const env = buildAgentEnvironment({ platform: 'win32' });
    expect(env.SystemRoot).toBeTruthy();
    expect(env.TEMP).toBe(process.env.TEMP);
    expect(env.USERPROFILE).toBe(process.env.USERPROFILE);
    // HOME falls back to USERPROFILE on win32 when HOME is unset.
    expect(env.HOME).toBe(process.env.HOME ?? process.env.USERPROFILE);
  });

  it('posix grants stay minimal and carry no Windows variables', () => {
    const env = buildAgentEnvironment({ platform: 'linux' });
    expect(env.SystemRoot).toBeUndefined();
    expect(env.USERPROFILE).toBeUndefined();
    expect(env.TERM).toBe('xterm-256color');
  });

  it('allowed variables still merge over the base', () => {
    const env = buildAgentEnvironment({ platform: 'linux', allowed: { CHOPSTICKS_HOOK_TOKEN: 'tok' } });
    expect(env.CHOPSTICKS_HOOK_TOKEN).toBe('tok');
  });
});
