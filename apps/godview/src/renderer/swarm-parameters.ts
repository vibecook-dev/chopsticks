export interface SwarmParameters {
  gravityPull: number;
  restitution: number;
  frictionAir: number;
  scanlineDensity: number;
  scanlineOpacity: number;
  vignetteOpacity: number;
  radiusIdle: number;
  radiusWorking: number;
  radiusWaiting: number;
}

export type SwarmParameterKey = keyof SwarmParameters;

export interface SwarmParameterDefinition {
  key: SwarmParameterKey;
  label: string;
  min: number;
  max: number;
  step: number;
}

export const DEFAULT_SWARM_PARAMETERS: Readonly<SwarmParameters> = {
  gravityPull: 0.0002,
  restitution: 0,
  frictionAir: 0.2,
  scanlineDensity: 2,
  scanlineOpacity: 0.4,
  vignetteOpacity: 1,
  radiusIdle: 40,
  radiusWorking: 50,
  radiusWaiting: 70,
};

export const PHYSICS_PARAMETER_DEFINITIONS = [
  { key: 'gravityPull', label: 'Center gravity', min: 0, max: 0.005, step: 0.0001 },
  { key: 'restitution', label: 'Bounciness', min: 0, max: 1, step: 0.1 },
  { key: 'frictionAir', label: 'Air friction', min: 0, max: 0.2, step: 0.01 },
] as const satisfies readonly SwarmParameterDefinition[];

export const OVERLAY_PARAMETER_DEFINITIONS = [
  { key: 'scanlineDensity', label: 'Line density', min: 2, max: 16, step: 1 },
  { key: 'scanlineOpacity', label: 'Line opacity', min: 0, max: 1, step: 0.05 },
  { key: 'vignetteOpacity', label: 'Vignette', min: 0, max: 1, step: 0.05 },
] as const satisfies readonly SwarmParameterDefinition[];

export const SIZE_PARAMETER_DEFINITIONS = [
  { key: 'radiusIdle', label: 'Idle size', min: 20, max: 80, step: 1 },
  { key: 'radiusWorking', label: 'Working size', min: 40, max: 120, step: 1 },
  { key: 'radiusWaiting', label: 'Waiting size', min: 60, max: 160, step: 1 },
] as const satisfies readonly SwarmParameterDefinition[];

const definitions = [...PHYSICS_PARAMETER_DEFINITIONS, ...OVERLAY_PARAMETER_DEFINITIONS, ...SIZE_PARAMETER_DEFINITIONS];

export function normalizeSwarmParameters(value: unknown): SwarmParameters {
  const source = value && typeof value === 'object' ? (value as Partial<Record<SwarmParameterKey, unknown>>) : {};
  const normalized = { ...DEFAULT_SWARM_PARAMETERS };
  for (const definition of definitions) {
    const candidate = source[definition.key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) continue;
    normalized[definition.key] = Math.max(definition.min, Math.min(definition.max, candidate));
  }
  return normalized;
}

export function radiusForStatus(
  parameters: Pick<SwarmParameters, 'radiusIdle' | 'radiusWorking' | 'radiusWaiting'>,
  status: 'idle' | 'working' | 'waiting',
): number {
  switch (status) {
    case 'idle':
      return parameters.radiusIdle;
    case 'working':
      return parameters.radiusWorking;
    case 'waiting':
      return parameters.radiusWaiting;
  }
}
