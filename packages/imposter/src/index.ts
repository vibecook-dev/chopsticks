/**
 * @vibecook/chopsticks-imposter — one executable that impersonates every
 * coding agent (draft/IMPOSTER.md).
 *
 * The imposter speaks each vendor's real machine surfaces — hooks, transcript
 * JSONL, statusline, JSON-RPC — projected from that vendor's captured Agent
 * Surface Model. What it deliberately does NOT reproduce is the vendor's
 * terminal interface: chopsticks never derives semantics from terminal text
 * (ADR-003/-004/-005), so a convincing fake screen would buy nothing and
 * invite the one mistake the whole design forbids (§1.1).
 *
 * ── Local convention: relative imports end in `.ts`, not `.js` ──────────────
 *
 * Every other package in this repo writes `./x.js`. This one writes `./x.ts`,
 * and the difference is load-bearing rather than stylistic.
 *
 * The imposter is SPAWNED as a process, in place of a vendor binary. Node's
 * type stripping resolves `./x.ts` but NOT `./x.js` (probed 2026-08-07), so
 * `.ts` extensions are what let `bin/ai.mjs` execute multi-file TypeScript
 * straight from `src/` with no build step — matching how every other package
 * is consumed from source during development. `rewriteRelativeImportExtensions`
 * rewrites them to `.js` on emit, so the published `dist/` is ordinary ESM.
 *
 * The alternative was bundling the bin, which would have made a build step a
 * prerequisite for running the conformance suite.
 */

export { createPasteDecoder, type PasteDecoder, type PasteOperation } from './session/channels/terminal.ts';
export {
  createHookEmitter,
  type HookEmitter,
  type HookEmitterOptions,
  type HookSettings,
} from './session/channels/hook.ts';
export { createTranscriptWriter, type TranscriptWriter } from './session/channels/transcript.ts';
export {
  createStatusLineInvoker,
  type StatusLineInvoker,
  type StatusLineInvokerOptions,
} from './session/channels/statusline.ts';
export {
  createScenarioRunner,
  type ScenarioAction,
  type ScenarioFault,
  type ScenarioRunner,
  type ScenarioRunnerOptions,
  type ScenarioStep,
  type ScenarioTimelineStep,
} from './session/scenario.ts';
