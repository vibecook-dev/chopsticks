import type { MonitorParameterGroup } from './monitor/parameters.js';

/**
 * The CRT treatment is painted over the whole window, not over the monitor
 * stage, so it belongs to the shell rather than to whichever view is mounted.
 * Splitting it out is what lets a view's own controls come and go with it.
 */
export const SCREEN_PARAMETER_GROUPS: readonly MonitorParameterGroup[] = [
  {
    title: 'CRT OVERLAYS',
    controls: [
      { key: 'scanlineDensity', label: 'Line density', min: 2, max: 16, step: 1, defaultValue: 2 },
      { key: 'scanlineOpacity', label: 'Line opacity', min: 0, max: 1, step: 0.05, defaultValue: 0.4 },
      { key: 'vignetteOpacity', label: 'Vignette', min: 0, max: 1, step: 0.05, defaultValue: 1 },
    ],
  },
];
