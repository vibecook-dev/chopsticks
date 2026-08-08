/**
 * @vibecook/chopsticks-emulator — the vendor-neutral emulator engine
 * (draft/EMULATOR.md §3–§5).
 *
 * The ASM runtime moved out to `@vibecook/chopsticks-surface`, which owns a
 * package so its type-stripping constraint stays compiler-enforced
 * (draft/IMPOSTER.md §7.1). The control channel moved to
 * `@vibecook/chopsticks-imposter` and `apps/emulator`, inverted onto one socket
 * (§5). What is left here is the PoC engine behind `surface/emulator/bin.mjs`,
 * retired at I4 — nothing new should depend on it.
 *
 * `.mjs` scripts must import the self-contained deep export (`…/engine`) rather
 * than this barrel — node type stripping does not remap the `.js`-suffixed
 * relative imports used here.
 */

export * from './engine.js';
