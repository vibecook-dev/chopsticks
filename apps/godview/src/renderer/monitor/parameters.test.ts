import { describe, expect, it } from 'vitest';
import { monitorParameterDefaults, normalizeMonitorParameters, type MonitorParameterGroup } from './parameters.js';

const groups: readonly MonitorParameterGroup[] = [
  {
    title: 'GROUP',
    controls: [
      { key: 'speed', label: 'Speed', min: 0, max: 10, step: 1, defaultValue: 4 },
      { key: 'depth', label: 'Depth', min: 1, max: 3, step: 0.5, defaultValue: 2 },
    ],
  },
];

describe('monitor parameters', () => {
  it('collects defaults across every declared group', () => {
    expect(monitorParameterDefaults(groups)).toEqual({ speed: 4, depth: 2 });
  });

  it('clamps stored values and falls back to the default for anything unusable', () => {
    expect(normalizeMonitorParameters(groups, { speed: 99, depth: Number.NaN })).toEqual({ speed: 10, depth: 2 });
    expect(normalizeMonitorParameters(groups, { speed: -1 })).toEqual({ speed: 0, depth: 2 });
    expect(normalizeMonitorParameters(groups, 'not an object')).toEqual({ speed: 4, depth: 2 });
  });

  it('drops keys no control declares, so a removed control cannot outlive it', () => {
    expect(normalizeMonitorParameters(groups, { speed: 3, radiusIdle: 40 })).toEqual({ speed: 3, depth: 2 });
  });
});
