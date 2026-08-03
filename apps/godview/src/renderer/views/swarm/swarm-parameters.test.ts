import { describe, expect, it } from 'vitest';
import { monitorParameterDefaults } from '../../monitor/parameters.js';
import {
  DEFAULT_SWARM_PARAMETERS,
  SWARM_PARAMETER_GROUPS,
  normalizeSwarmParameters,
  radiusForStatus,
} from './swarm-parameters.js';

describe('swarm parameters', () => {
  it('matches the original prototype defaults', () => {
    expect(DEFAULT_SWARM_PARAMETERS).toEqual({
      gravityPull: 0.0002,
      restitution: 0,
      frictionAir: 0.2,
      radiusIdle: 40,
      radiusWorking: 50,
      radiusWaiting: 70,
    });
  });

  it('declares the same defaults to the shell that it applies itself', () => {
    expect(monitorParameterDefaults(SWARM_PARAMETER_GROUPS)).toEqual({ ...DEFAULT_SWARM_PARAMETERS });
  });

  it('restores finite values and clamps them to the tweak panel ranges', () => {
    expect(
      normalizeSwarmParameters({ gravityPull: 2, restitution: -1, radiusWorking: 91, radiusWaiting: NaN }),
    ).toMatchObject({ gravityPull: 0.005, restitution: 0, radiusWorking: 91, radiusWaiting: 70 });
  });

  it('maps every live status to its configured radius', () => {
    expect(radiusForStatus(DEFAULT_SWARM_PARAMETERS, 'idle')).toBe(40);
    expect(radiusForStatus(DEFAULT_SWARM_PARAMETERS, 'working')).toBe(50);
    expect(radiusForStatus(DEFAULT_SWARM_PARAMETERS, 'waiting')).toBe(70);
  });
});
