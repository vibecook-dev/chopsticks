/**
 * @vibecook/chopsticks-emulator — Agent Surface Model runtime and
 * vendor-neutral emulator engine (draft/EMULATOR.md).
 *
 * `.mjs` scripts should import `@vibecook/chopsticks-emulator/model` (the
 * self-contained deep export) rather than this barrel — node type stripping
 * does not remap the `.js`-suffixed relative imports used here.
 */

export * from './model.js';
export * from './engine.js';
export * from './control.js';
