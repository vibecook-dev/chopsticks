/**
 * @vibecook/chopsticks-emulator — vendor-neutral emulator engine and control
 * channel (draft/EMULATOR.md §3–§6).
 *
 * The ASM runtime moved out to `@vibecook/chopsticks-surface`, which owns a
 * package so its type-stripping constraint stays compiler-enforced
 * (draft/IMPOSTER.md §7.1). This package is itself being retired into
 * `@vibecook/chopsticks-imposter` (§7.2) — nothing new should depend on it.
 *
 * `.mjs` scripts must import the self-contained deep exports (`…/engine`,
 * `…/control`) rather than this barrel — node type stripping does not remap
 * the `.js`-suffixed relative imports used here.
 */

export * from './engine.js';
export * from './control.js';
