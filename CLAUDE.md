# Chopsticks

A provider-neutral TypeScript runtime that **hosts coding agents' own terminal UIs**. Claude Code
looks like Claude Code; Codex looks like Codex. Chopsticks owns the process environment around that
UI — lifecycle, observation, guarded control, workspace isolation, receipts — and derives semantic
state from native side channels, never by reading the screen.

`draft/DESIGN.md` is the canonical architecture (ADRs, §-numbered; comments across the codebase cite
it). `draft/IMPLEMENTATION-PLAN.md` records what was scoped, deferred, and rejected, and why.
`draft/EMULATOR.md` + `draft/ADAPTING-AN-AGENT.md` specify the Agent Surface Model (ASM) and the
standard six-step adapter workflow. **`draft/IMPOSTER.md` is the live document for the emulator
stack** — it supersedes EMULATOR.md §4–§6 and §8 (I4, 2026-08-08); EMULATOR.md §1, §2, and §7 still
stand. One executable (`ai`) impersonates every vendor from a persona; there are no per-adapter bins.

## Sibling repos (this is layer 2 of 3)

| Repo | Role | Boundary |
|---|---|---|
| `p008/spaghetti` | Static agent-data plane: SQLite/FTS index of transcripts, settings, todos | Bytes left on disk |
| **chopsticks** | Live lifecycle: spawn, observe, control, isolate | A live handle to an agent process |
| `project100/electron-ghostty` | Ghosttea terminal stack (the PTY spine) — repo is `vibecook-dev/ghosttea` | Terminal rendering and PTY ownership |

Chopsticks persists **operational state only**. It never grows browse or search features — if its
records become worth searching, spaghetti indexes them as one more file source.

## Invariants — do not break these without revisiting DESIGN

- **Never derive semantics from terminal text.** Priority order: native hooks/protocols → native
  logs/transcripts → workspace/process observation → screen inference (always marked inferred).
  (ADR-003/-004/-005)
- **One native session = one agent process.** Never spawn a shadow `--print`/`exec` process to
  shadow a TUI session. Never pass `-p`, `--print`, or stream-json flags to an interactive launch.
  (ADR-002)
- **`core` is zero-I/O.** No PTY, process, socket, or filesystem access — types, the reducer, and
  pure helpers only. I/O lives in adapters or the app.
- **Adapters reach terminals only through `AgentHost`** (`packages/core/src/host.ts`): `spawnTerminal`
  + `automateTerminal`. Everything else (app-servers, leaders, sockets, transcripts) the adapter
  builds itself. Applications supply the host.
- **Unknown native events are retained verbatim** as `UnknownNativeEvent` rather than dropped.
  (ADR-008)
- **Prompt injection never overstates certainty.** Claude's guarded bracketed paste confirms against
  a matching `UserPromptSubmit`; `PromptReceipt` may legitimately be `uncertain`. Structured drivers
  (Codex) get deterministic confirmation via `clientUserMessageId` — don't unify them by pretending
  the paste path is deterministic.
- **Launch environments can carry session bearer tokens.** Never log or persist them.

## Layout

```
packages/
  core/          AgentEvent union (29 members) + reduceSessionState + AgentHost + ObservationLevel
  runtime/       AgentRuntime — the single app-facing surface; providers, git observer, conversation
  adapter-claude/  hooks bridge, generated settings, transcript observer (spaghetti SDK), statusline usage
  adapter-codex/   app-server JSON-RPC over WS-in-UDS, structured driver, TUI attach via --remote
  adapter-acp/     generic ACP driver;  adapter-grok/ layers on it (--leader coexistence)
  workspaces/    direct | exclusive | worktree | copy isolation + final-diff metadata
  record/        append-only JSONL of runtime-owned actions;  testing/ fake agent + conformance
  surface/       the ASM runtime (loadModel, validatePayload, drift) + the capture sanitiser.
                 SELF-CONTAINED and `erasableSyntaxOnly` — surface .mjs scripts import it under node
                 type stripping, which is why it owns a package (draft/IMPOSTER.md §7.1)
  imposter/      `ai` — one executable that impersonates every vendor from its captured ASM.
                 personas/<vendor>/ (ops, boot, behavior, scenarios), session + channels, op timeline,
                 session/machine.ts (the xstate lifecycle over the op vocabulary — DESCRIPTIVE, it
                 never gates; off-model ops are counted, not refused), scenario runner, control/ (UDS
                 JSON-RPC client + shared protocol), tui/ (one shared Ink chrome, dynamically imported
                 ONLY on a TTY — it costs ~40 MB of RSS, and `CHOPSTICKS_IMPOSTER_TUI=off` forces the
                 append-only sink). Relative imports end in `.ts` here, NOT `.js` — see
                 packages/imposter/src/index.ts for why. `ai link` puts `ai` on PATH without shadowing
                 anything; `ai shims install` writes `claude`/… symlinks, which deliberately DO shadow

`adapter-<vendor>/surface/` holds the adapter-owned ground truth (draft/EMULATOR.md):
`model/<vendor>@<version>/` (ASM — canonical; registry.ts is GENERATED from it via
`surface/generate-registry.mjs`), `captures/` (sanitized census fixtures, repo-only), `captures-raw/`
(verbatim evidence, gitignored/private), `audit.mjs` (model + schema + privacy ↔ captures
diff — `pnpm --filter @vibecook/chopsticks-adapter-claude run surface:audit`). The vendor stand-in is
NOT here: it is a persona in `packages/imposter/personas/<vendor>/`, and conformance runs against
`ai` hermetically. Surface .mjs scripts need node ≥22.18 (type stripping) and import only
self-contained modules — that constraint is why `packages/surface` owns a package and sets
`erasableSyntaxOnly`.
apps/
  godview/       current focus — Electron swarm view (matter.js bubbles, panes, usage panel)
  workbench/     the original dev app (agent chat panel, per-agent tabs)
  emulator/      emulator control center (no ghosttea dep — builds anywhere; `pnpm emulator`).
                 Owns the control plane: one UDS at `~/.chopsticks/imposter.sock` that imposters dial
                 into, plus a loopback HTTP+SSE console. Liveness is socket close — there is no
                 discovery file and nothing polls (draft/IMPOSTER.md §5). The console draws the
                 imposter's own machine (served at /api/machine, never copied into the page) and
                 drives sessions by OP first; raw events, scenarios and faults are the adversarial
                 path and deliberately do not move the graph (§11)
```

`packages/node` is **gone** (commit `1eea6db`) — the PTY spine moved to electron-ghostty. Empty
gitignored `dist/`+`node_modules/` husks may linger on disk.

## Commands

```sh
pnpm test           # typecheck + script tests + every package and app suite
pnpm godview        # bundle + launch the Electron swarm app
pnpm workbench      # bundle + launch the original workbench
pnpm format         # prettier --write over packages/*/src (CI runs format:check FIRST)
pnpm pack:check     # build + pack every public package into tarballs
pnpm ai:link        # symlink `ai` into a dir already on PATH — then `ai --claude`, `ai --codex`
```

Live adapter probes are opt-in and skipped by default: `CODEX_LIVE=1`, `GROK_LIVE=1`,
`CHOPSTICKS_REAL_CLAUDE=1`. Agent binaries resolve from PATH or `CHOPSTICKS_{CLAUDE,CODEX,GROK}_BIN`.

**CI covers `packages/**` and `apps/**` in separate jobs.** The apps consume everything Ghosttea
from npm at an exact pinned version, including the two native artifacts that used to require the
sibling checkout: the daemon prebuilt through `@vibecook/ghosttead` (override with `GHOSTTEAD_BIN`
to run one built from source) and the tab-ordering addon through `@vibecook/ghosttea-native-tabs`.
No sibling checkout or Rust toolchain is needed anymore.

**Never import `@vibecook/ghosttead` from app `main`.** It is ESM-only, and Electron's bundled Node
cannot `require` it from a CJS bundle — bundled *or* external. `build.mjs` calls `ghostteadPath()`
at build time and stages the binary into `dist/bin/`, the same shape as the native tabs addon;
where no prebuild exists the staging is skipped and `GHOSTTEAD_BIN` is required. This fails only at
launch, so **verify app changes with `pnpm godview:smoke`, not just the suite.** Pass
`GHOSTTEA_TRUFFLE_ENABLED=false` to smoke without a Tailscale login.

## Conventions

- ESM throughout: relative imports end in `.js` even in TypeScript. `verbatimModuleSyntax` is on, so
  type-only imports need `import type`.
- In-repo `exports` point at `./src/index.ts`; `publishConfig` remaps to `dist` at pack time. Cross-package
  changes need no build step during development.
- Expected failures return typed result objects (`{ error: { code, message } }`) rather than throwing;
  codes are unions like `PreparationErrorCode`. Throwing is for programmer error.
- Comments explain **why** — a rationale, a protocol quirk, a DESIGN reference. Match that register;
  don't add comments that restate the code.
- Prettier: single quotes, trailing commas, width 120.
- Providers stay behind the `AgentProvider` seam in `packages/runtime/src/providers.ts`. Adding an
  agent means a new adapter + provider entry + a variant in `BuiltinCreateAgentSessionOptions` —
  never provider-specific branching inside `runtime.ts`.

## Releases

release-please owns versions and tags; **never hand-bump a version**. All public packages release in
lockstep from the root manifest, including the `// x-release-please-version` markers in
`packages/core/src/index.ts` and two adapter-codex files. Publishing goes through tokenless npm
trusted publishing in `.github/workflows/release.yml`. To retry a partial publish:
`gh workflow run release.yml --ref main -f tag=vX.Y.Z`.

Applications should pin `@vibecook/chopsticks-runtime` exactly and treat upgrades as deliberate
integration events. Node.js 22+.
