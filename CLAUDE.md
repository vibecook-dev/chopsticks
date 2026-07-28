# Chopsticks

A provider-neutral TypeScript runtime that **hosts coding agents' own terminal UIs**. Claude Code
looks like Claude Code; Codex looks like Codex. Chopsticks owns the process environment around that
UI — lifecycle, observation, guarded control, workspace isolation, receipts — and derives semantic
state from native side channels, never by reading the screen.

`draft/DESIGN.md` is the canonical architecture (ADRs, §-numbered; comments across the codebase cite
it). `draft/IMPLEMENTATION-PLAN.md` records what was scoped, deferred, and rejected, and why.

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
apps/
  godview/       current focus — Electron swarm view (matter.js bubbles, panes, usage panel)
  workbench/     the original dev app (agent chat panel, per-agent tabs)
```

`packages/node` is **gone** (commit `1eea6db`) — the PTY spine moved to electron-ghostty. Empty
gitignored `dist/`+`node_modules/` husks may linger on disk.

## Commands

```sh
pnpm test           # typecheck + script tests + every package and app suite
pnpm godview        # bundle + launch the Electron swarm app (needs the sibling for native artifacts)
pnpm workbench      # bundle + launch the original workbench
pnpm format         # prettier --write over packages/*/src (CI runs format:check FIRST)
pnpm pack:check     # build + pack every public package into tarballs
```

Live adapter probes are opt-in and skipped by default: `CODEX_LIVE=1`, `GROK_LIVE=1`,
`CHOPSTICKS_REAL_CLAUDE=1`. Agent binaries resolve from PATH or `CHOPSTICKS_{CLAUDE,CODEX,GROK}_BIN`.

**CI only covers `packages/**`.** The apps consume the Ghosttea JS packages from npm at an exact
pinned version, but still need the `electron-ghostty` sibling checkout for two unpublished native
artifacts — the `ghosttea_native_tabs.node` addon and the cargo-built `ghosttead` daemon (override
the latter with `GHOSTTEAD_BIN`). That keeps the apps out of CI, so app regressions are caught only
by running their suites locally.

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
