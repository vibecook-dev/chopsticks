import type { SwarmParameterDefinition, SwarmParameterKey, SwarmParameters } from './swarm-parameters.js';
import {
  OVERLAY_PARAMETER_DEFINITIONS,
  PHYSICS_PARAMETER_DEFINITIONS,
  SIZE_PARAMETER_DEFINITIONS,
} from './swarm-parameters.js';

type GodviewTheme = 'light' | 'dark';

interface TweakPanelProps {
  open: boolean;
  theme: GodviewTheme;
  parameters: SwarmParameters;
  onClose: () => void;
  onThemeChange: (theme: GodviewTheme) => void;
  onParameterChange: (key: SwarmParameterKey, value: number) => void;
  onReset: () => void;
}

function displayedValue(definition: SwarmParameterDefinition, value: number): string {
  if (definition.step >= 1) return String(Math.round(value));
  const precision = Math.max(0, Math.ceil(-Math.log10(definition.step)));
  return value.toFixed(precision);
}

function ParameterGroup({
  title,
  definitions,
  parameters,
  onChange,
}: {
  title: string;
  definitions: readonly SwarmParameterDefinition[];
  parameters: SwarmParameters;
  onChange: (key: SwarmParameterKey, value: number) => void;
}) {
  return (
    <fieldset className="tweak-group">
      <legend>{title}</legend>
      {definitions.map((definition) => {
        const value = parameters[definition.key];
        return (
          <label className="tweak-control" key={definition.key}>
            <span>{definition.label}</span>
            <output>{displayedValue(definition, value)}</output>
            <input
              type="range"
              min={definition.min}
              max={definition.max}
              step={definition.step}
              value={value}
              onChange={(event) => onChange(definition.key, event.currentTarget.valueAsNumber)}
            />
          </label>
        );
      })}
    </fieldset>
  );
}

export function TweakPanel({
  open,
  theme,
  parameters,
  onClose,
  onThemeChange,
  onParameterChange,
  onReset,
}: TweakPanelProps) {
  if (!open) return null;
  return (
    <aside id="godview-tweak-panel" className="godview-tweak-panel" aria-label="Godview system controls">
      <header>
        <span>SYSTEM CONTROL</span>
        <button type="button" aria-label="Close system controls" onClick={onClose}>
          ×
        </button>
      </header>
      <label className="tweak-theme">
        <span>Theme</span>
        <select value={theme} onChange={(event) => onThemeChange(event.currentTarget.value as GodviewTheme)}>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <ParameterGroup
        title="CRT OVERLAYS"
        definitions={OVERLAY_PARAMETER_DEFINITIONS}
        parameters={parameters}
        onChange={onParameterChange}
      />
      <ParameterGroup
        title="ENGINE VARIABLES"
        definitions={PHYSICS_PARAMETER_DEFINITIONS}
        parameters={parameters}
        onChange={onParameterChange}
      />
      <ParameterGroup
        title="AGENT SIZES"
        definitions={SIZE_PARAMETER_DEFINITIONS}
        parameters={parameters}
        onChange={onParameterChange}
      />
      <button className="tweak-reset" type="button" onClick={onReset}>
        RESET DEFAULTS
      </button>
    </aside>
  );
}
