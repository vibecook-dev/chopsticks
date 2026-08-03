import type { MonitorParameterDefinition, MonitorParameterGroup, MonitorParameters } from './monitor/parameters.js';

type GodviewTheme = 'light' | 'dark';

/** One group of sliders bound to whichever store owns those keys. */
export interface TweakSection {
  id: string;
  group: MonitorParameterGroup;
  values: MonitorParameters;
  onChange: (key: string, value: number) => void;
}

interface TweakPanelProps {
  open: boolean;
  theme: GodviewTheme;
  sections: readonly TweakSection[];
  onClose: () => void;
  onThemeChange: (theme: GodviewTheme) => void;
  onReset: () => void;
}

function displayedValue(definition: MonitorParameterDefinition, value: number): string {
  if (definition.step >= 1) return String(Math.round(value));
  const precision = Math.max(0, Math.ceil(-Math.log10(definition.step)));
  return value.toFixed(precision);
}

function ParameterGroup({ group, values, onChange }: Omit<TweakSection, 'id'>) {
  return (
    <fieldset className="tweak-group">
      <legend>{group.title}</legend>
      {group.controls.map((definition) => {
        const value = values[definition.key] ?? definition.defaultValue;
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

export function TweakPanel({ open, theme, sections, onClose, onThemeChange, onReset }: TweakPanelProps) {
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
      {sections.map((section) => (
        <ParameterGroup key={section.id} group={section.group} values={section.values} onChange={section.onChange} />
      ))}
      <button className="tweak-reset" type="button" onClick={onReset}>
        RESET DEFAULTS
      </button>
    </aside>
  );
}
