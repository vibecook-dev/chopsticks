/**
 * The tunable numbers a monitor view exposes to the tweak panel.
 *
 * Views declare their controls and read them back through their own typed
 * normalizer; the shell owns defaults, clamping, and persistence. That split is
 * what lets a view be added without touching the panel, and what keeps a key
 * left behind by a deleted control from surviving into a later run.
 */
export interface MonitorParameterDefinition {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
}

export interface MonitorParameterGroup {
  title: string;
  controls: readonly MonitorParameterDefinition[];
}

/** A flat numeric bag; each view narrows it at its own boundary. */
export type MonitorParameters = Readonly<Record<string, number>>;

export function monitorParameterDefaults(groups: readonly MonitorParameterGroup[]): MonitorParameters {
  const defaults: Record<string, number> = {};
  for (const group of groups) {
    for (const control of group.controls) defaults[control.key] = control.defaultValue;
  }
  return defaults;
}

/** Known keys clamped to their control's range; everything else is dropped. */
export function normalizeMonitorParameters(
  groups: readonly MonitorParameterGroup[],
  value: unknown,
): MonitorParameters {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const normalized: Record<string, number> = {};
  for (const group of groups) {
    for (const control of group.controls) {
      const candidate = source[control.key];
      normalized[control.key] =
        typeof candidate === 'number' && Number.isFinite(candidate)
          ? Math.max(control.min, Math.min(control.max, candidate))
          : control.defaultValue;
    }
  }
  return normalized;
}

function readStoredJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    // A disabled storage partition, or a value this build cannot parse.
    return undefined;
  }
}

/**
 * `legacyStorageKey` is where every tunable lived before views owned their own
 * controls. Reading it as a fallback means an existing installation keeps the
 * look it was tuned to; normalization drops the keys that moved elsewhere.
 */
export function loadMonitorParameters(
  storageKey: string,
  groups: readonly MonitorParameterGroup[],
  legacyStorageKey?: string,
): MonitorParameters {
  const stored = readStoredJson(storageKey);
  if (stored !== undefined) return normalizeMonitorParameters(groups, stored);
  return normalizeMonitorParameters(groups, legacyStorageKey ? readStoredJson(legacyStorageKey) : undefined);
}

export function saveMonitorParameters(storageKey: string, parameters: MonitorParameters): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(parameters));
  } catch {
    // Keep the live controls usable when persistence is unavailable.
  }
}
