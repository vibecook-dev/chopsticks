# Chopsticks Agent Emulator & Surface Model — v0.1

**Status:** Draft for review
**Created:** 2026-08-07
**Companion:** `draft/DESIGN.md` (canonical architecture; this extends §26 Testing Strategy), `draft/ADAPTING-AN-AGENT.md` (the per-adapter workflow this spec enables)
**Supersedes:** nothing yet — `probe/` was the spike; this is the pipeline it graduates into

---

## 0. Charter

> Fact-checking chopsticks today requires running real agent CLIs: slow, nondeterministic, token-burning, and incapable of eliciting most failure paths on demand. Make the **captured surface** of each vendor a first-class, versioned artifact, project it into a **scriptable emulator** of that vendor, and run the entire product — conformance suite, apps, manual QA — against emulators, with a nightly reconciliation lane that re-verifies the emulators against the real binaries.

---

## 1. The one rule that keeps this honest

**The emulator is a reconciled projection of captured truth, never the source of truth.**

```
real vendor CLI ──census/capture──▶ surface/captures/ ──distill──▶ surface/model/ (ASM)
                                                                        │
                                              two projections, one truth ▼
                                    ┌─ adapter data (registry, fixtures, normalizer expectations)
                                    └─ emulator behavior packs (surface/emulator/)
nightly: run the same scenario pack against the real CLI AND the emulator;
         any diff = drift → triage → model update
```

Corollaries (do not relitigate):

| Rule | Why |
|---|---|
| Truth flows real CLI → captures → model → emulator, never the reverse | A hand-written emulator embodies *beliefs*; when the vendor drifts, every test passes confidently on a wrong model |
| The nightly live-reconciliation lane is not optional | It is the price of trusting the emulator everywhere else. Skip it and the edifice rots silently within a few vendor releases |
| Emulator and normalizer must never be derived from the same unverified source | Otherwise they are wrong together in the same way and no test can see it. Both derive from — and diff against — captures |
| The emulator is a *replacement* binary for dev/test, never a sidecar to a live session | ADR-002 (one native session = one agent process) is unaffected |

---

## 2. Agent Surface Model (ASM) — the formal contract

The ASM is the canonical, machine-readable description of everything a vendor exposes that an adapter depends on. It lives **inside the adapter package** (each adapter owns its truth-checking), is **JSON canonical** (diffable, tool-consumable, no build step), and is **versioned per vendor version**.

### 2.1 Layout

```
packages/adapter-<vendor>/surface/
  model/
    <vendor>@<version>/           # e.g. claude@2.1.207
      manifest.json               # asmVersion, vendor, vendorVersion, generated-at, tool versions
      detection.json              # binary names, --version shape, capability probes, min/max supported
      channels.json               # channel ids → transport, addressing, lifecycle (§2.3)
      events/<Event>.json         # one file per native event/method/notification (§2.2)
  captures/
    <vendor>@<version>/           # raw census output; today's probe/captures migrates here
      <Event>.jsonl
  emulator/
    bin.mjs                       # executable the adapter spawns in place of the vendor CLI (§4)
    behavior/*.json               # stimulus → response rules over the events in model/
    scenarios/*.json              # named timelines (§5.2)
  audit.mjs                       # census → surface-report.json → diff against model/ (§7)
```

`asmVersion` versions the *format*; the directory name versions the *vendor*. Multiple vendor versions may coexist side by side — `git diff` between two version directories **is** the vendor API changelog, mechanically derived.

### 2.2 Event file

```json
{
  "surface": "claude",
  "surfaceVersion": "2.1.207",
  "event": "UserPromptSubmit",
  "channel": "hook",
  "transport": "http",
  "trigger": "user submits a prompt in the TUI",
  "payloadSchema": {
    "type": "object",
    "required": ["session_id", "transcript_path", "cwd", "hook_event_name", "prompt", "prompt_id"],
    "properties": { "prompt": { "type": "string" }, "prompt_id": { "type": "string", "format": "uuid" } }
  },
  "confidence": "verified-headless",
  "timeoutSec": 5,
  "firstSeen": "2.1.207",
  "lastVerified": "2.1.207",
  "fixture": "captures/claude@2.1.207/UserPromptSubmit.jsonl",
  "notes": "prompt is verbatim — §17.2 exact-match confirmation"
}
```

- `payloadSchema` is a **JSON-Schema subset** (object/required/properties, primitives, arrays, enums). The engine ships a minimal validator; no new runtime dependency.
- `confidence` reuses the registry's existing ladder: `verified-headless` | `verified-interactive` | `unverified`.
- `lastVerified` makes staleness self-reporting: the nightly audit bumps it when the event is observed unchanged, or files a drift issue when it isn't observed / differs.

### 2.3 Channels

A channel is one wire the adapter and vendor exchange semantics over. `channels.json` enumerates them; the emulator engine implements one simulator per channel *kind*, configured per vendor:

| Channel kind | Vendor example | Simulator in engine |
|---|---|---|
| `argv-env` | claude `--session-id`, `--settings`, `--permission-mode` | argv/env parser + acceptance behavior (incl. silently-tolerated unknowns) |
| `hook-http` | claude `type:"http"` hooks | loopback HTTP client POSTing to the adapter's real bridge |
| `hook-command` | claude command hooks | spawn the configured forwarder command |
| `transcript` | `~/.claude/projects/<slug>/<uuid>.jsonl` | JSONL writer emitting real record shapes, incl. partial-flush control |
| `statusline` | claude statusline command | invokes the configured command with the real stdin JSON |
| `jsonrpc-stdio` | codex `app-server` | JSON-RPC 2.0 endpoint: requests, responses, server requests, notifications |
| `jsonrpc-ws-uds` | codex `--remote` attach | WebSocket-in-UDS listener |
| `terminal` | the TUI itself | minimal stub: alt-screen, echo, bracketed-paste accept (§3) |

Detection (`detection.json`) covers what the adapter's probe relies on: binary resolution, `--version` output shape, and capability flags. The emulator bin must answer the detection surface plausibly (§4).

---

## 3. Fidelity ladder

Three levels; each is validated against the one above.

| Level | What | Status |
|---|---|---|
| **L0 — scripted transports** | In-memory JSON-RPC, scripted ACP connector. Unit-test doubles | **exists** (`adapter-codex` in-memory transport, `adapter-acp/scripted-connector.ts`) |
| **L1 — behavioral emulator** | A real subprocess speaking the vendor's real channels, driven by the behavior pack; scenario-scriptable | this spec |
| **L2 — recorded replay** | Real captured sessions replayed verbatim (hook timings, transcript bytes, notification sequences) | this spec; scenarios of kind `replay` |

L1 exists only because chopsticks never parses terminal text (ADR-003/-004/-005): the entire semantic surface to reproduce faithfully is hooks, transcripts, statusline, and JSON-RPC — all file- or socket-based, all scriptable. The terminal channel is a stub by design. **Consequence (accepted):** in emulator mode an app's terminal pane shows the stub TUI, not the vendor's real interface; every semantic surface (state, events, panes, usage) behaves fully.

---

## 4. The emulator bin contract

Each adapter ships `surface/emulator/bin.mjs` — a Node executable (shebang + platform shim generated by the engine; Windows gets a `.cmd` wrapper) that the adapter spawns **in place of the vendor CLI**, resolved through the existing seams: `CHOPSTICKS_{CLAUDE,CODEX,GROK}_BIN` or `BuiltinProviderOptions.executables`. No adapter code changes are required for basic emulation.

The bin MUST:

1. **Branch on argv the way the vendor does.** e.g. codex: `app-server` subcommand → JSON-RPC daemon; bare invocation → TUI stub that attaches via `--remote`. grok: `--leader` backend vs TUI.
2. **Implement the detection surface** from `detection.json` (`--version` shape, probed flags) so adapter detection behaves as against the real binary.
3. **Bring up every channel** declared in `channels.json`, using the engine's simulators, driven by `behavior/`.
4. **Read `~/.chopsticks/emulator-control.json`** (written by the control center, §6); if present and reachable, register and serve the control API; if absent, run standalone on default behavior (still fully usable in CI).
5. **Never require network or vendor credentials.**

The bin SHOULD treat unknown argv/env the way the real vendor does (claude silently tolerates unknown hook names; mirror that) — the ASM is where such quirks live, as data.

**P2 delivery note (claude bin):** items 1–3 and 5 are delivered (`packages/adapter-claude/surface/emulator/bin.mjs`), including the statusline channel — the bin invokes the adapter's real forwarder script at boot (known-empty window) and after each turn (cumulative usage + `rate_limits`), so context-window, environment, and account-usage flows are exercised end to end. Item 4 lands with P3's control center. One documented compromise: the engine's hook emitter recognizes the repo's own generated curl-forwarder shape and delivers it as a direct POST with identical headers/body — byte-identical at the bridge, but independent of `sh`, which keeps command-transport events (SessionStart gates readiness) working on Windows dev machines. Unrecognized command handlers still run through `sh -c`.

---

## 5. Behavior packs and scenarios

### 5.1 Behavior rules

Stimulus → response rules over ASM events, evaluated by the engine:

```json
{
  "on": { "channel": "terminal", "stimulus": "paste" },
  "then": [
    { "emit": { "channel": "hook", "event": "UserPromptSubmit", "with": { "prompt": "$stimulus.text" } } },
    { "replay": { "channel": "transcript", "fixture": "assistant-turn.jsonl", "intervalMs": 80 } },
    { "emit": { "channel": "hook", "event": "Stop", "afterMs": 400 } }
  ]
}
```

`$stimulus.*` binds captured input; `afterMs`/`intervalMs` give deterministic timing; payloads are validated against the ASM `payloadSchema` before emission (an emulator that emits off-model payloads fails its own tests).

### 5.2 Scenarios

Named timelines for fault and stress cases the behavior rules don't cover organically:

```json
{
  "name": "crash-mid-turn",
  "steps": [
    { "at": 0, "do": { "emit": { "channel": "hook", "event": "UserPromptSubmit", "with": { "prompt": "refactor" } } } },
    { "at": 300, "do": { "emit": { "channel": "hook", "event": "PreToolUse", "with": { "tool_name": "Bash" } } } },
    { "at": 600, "do": { "fault": { "kind": "crash", "signal": "SIGKILL", "leaveTranscriptPartial": true } } }
  ]
}
```

Required starter set per adapter (extends DESIGN §26.1): happy turn, permission request → allow, permission → deny (absence-pattern for claude, structured request for codex), hook arriving after process exit, duplicate + out-of-order events, an **unknown event** (verifies ADR-008 retention end-to-end), flood, crash mid-turn, channel disconnect (hook bridge loss, app-server socket drop), token/usage refresh.

### 5.3 Replay scenarios

Kind `replay`: a real captured session (hooks + transcript + JSON-RPC logs) replayed verbatim with original timings or a speed factor. Regression tests against shapes that actually happened in production.

---

## 6. The control center (`apps/emulator`)

An Electron app on the same skeleton as `apps/workbench`/`apps/godview` — the interactive half of the emulator story: spawn any agent in emulator mode and trigger its events by hand while the product app reacts.

### 6.1 Discovery and registration

- The control center listens on loopback and writes `~/.chopsticks/emulator-control.json`: `{ "url", "token", "pid" }`. Loopback + bearer token, body limits — same discipline as the hook bridge (DESIGN §16.6).
- Each emulator bin, at startup, reads that file and `POST /register`s: `{ vendor, sessionId, pid, controlUrl, controlToken, channels }`. The emulator serves its own control server; the center talks to it directly (the center is a console, not a message bus). If registration fails or the file is absent, the emulator runs standalone — CI never depends on the center.
- `sessionId` correlation comes free: the adapter's launch recipe already hands the vendor its session id (`--session-id` for claude; thread id for codex), and the emulator parses it from argv like the real CLI would.

### 6.2 Control API (served by each emulator)

| Endpoint | Effect |
|---|---|
| `GET /state` | vendor, sessionId, live channels, cursor into the emitted log |
| `GET /log` | everything emitted so far (assertion + debugging aid) |
| `POST /trigger` | fire one event now: `{ channel, event, with }` — payload schema-validated |
| `POST /scenario` | `{ name \| script, mode: play\|pause\|step, speed }` |
| `POST /fault` | `{ kind: crash\|hang\|flood\|exit\|channel-drop, ... }` |

### 6.3 UI panels

1. **Live sessions** — registered emulators, keyed by vendor + session id, with channel liveness.
2. **Event palette** — generated from the ASM: one form per event, fields from `payloadSchema`, fire via `/trigger`.
3. **Scenario runner** — pick a scenario, play/pause/step, watch emitted traffic live.

The same app later gains **record**: attach to a *real* session's captures and save as a replay scenario — closing the record/replay loop without a second tool.

### 6.4 Emulator mode in product apps

```
1. pnpm emulator                      # control center starts, awaits registrations
2. CHOPSTICKS_CLAUDE_BIN=<abs>/packages/adapter-claude/surface/emulator/bin.mjs pnpm godview
3. godview: create a Claude session as usual
   → adapter spawns the emulator bin → emulator registers with the control center
4. control center: trigger a permission request, step a turn, crash the agent
5. godview's panes, bubbles, and usage panels behave as if Claude were live
```

Godview/workbench may grow a `--emulate` convenience flag that sets `executables` itself; the env seam already works today with zero app code.

---

## 7. Reconciliation — the nightly lane

`audit.mjs` per adapter is the productized census (what `probe/` did by hand):

1. Run the census against the installed vendor binary → `surface-report.json`.
2. Diff against `surface/model/<vendor>@<version>/`: unobserved model entries, observed-but-unmodeled events, payload-shape changes.
3. Replay the standard scenario pack against **both** the real CLI and the emulator; diff channel outputs.
4. Any diff → GitHub issue with the report; clean run → bump `lastVerified`.

Scheduling: a nightly GitHub Actions workflow with the existing opt-in lanes enabled (`CHOPSTICKS_REAL_CLAUDE=1`, `CODEX_LIVE=1`, `GROK_LIVE=1`). The pinned-version CI lane (emulator-based, hermetic) stays green and protects consumers; the nightly latest lane is allowed red — it is an early-warning system, not a gate. The live tests already in the adapters (`*.live.test.ts`) run in exactly this lane.

**Drift equation:** `drift = diff(real census, model) ∪ diff(emulator behavior, model)`. Both halves are mechanical; neither involves reading vendor changelogs (which lag or don't exist — Phase 0's lesson).

---

## 8. Limits and non-goals

- The emulator **cannot detect vendor drift by itself.** Only reconciliation against the real binary can. There is no version of this system where the nightly lane is deleted.
- The terminal channel is a stub (§3). Apps whose own features depend on terminal *pixels* still need real-vendor manual QA.
- OAuth / account-usage flows are emulated at the HTTP layer (fake usage endpoint). The live `account-usage.live.test.ts` stays in the nightly lane forever.
- Not a goal: emulating vendors' *model quality*. Prompts to an emulator get scripted responses; nothing here evaluates agent intelligence.
- Not a goal: a shadow process beside a live session (ADR-002). The emulator replaces the vendor binary; it never accompanies it.

---

## 9. Package and ownership summary

| Piece | Location | Public? |
|---|---|---|
| Emulator engine (ASM validator/differ, channel simulators, scenario runner, control server) | `packages/emulator` — `@vibecook/chopsticks-emulator` | yes — consumers get hermetic integration tests of *their* apps too |
| Conformance suite, fake agent, shared fixtures | `packages/testing` (unchanged charter; gains an emulator-backed mode) | yes |
| Per-vendor ASM, captures, behavior packs, bins, audit scripts | `packages/adapter-<vendor>/surface/` | model ships inside each adapter package (`files: ["dist", "surface/model"]`); captures stay repo-only |
| Control center | `apps/emulator` | private, like the other apps |

**Consumption constraint (learned in P1):** node type stripping does not remap `./x.js` → `./x.ts`, so `.mjs` surface scripts (audit, generation) cannot import modules that use the repo's `.js`-suffixed relative imports. Any module those scripts consume must be self-contained — hence the ASM runtime lives in one file, exposed as the deep export `@vibecook/chopsticks-emulator/model` (TS consumers use the barrel). Scripts require node ≥ 22.18 (type stripping; older 22.x: `--experimental-strip-types`). The emulator package's tsconfig sets `erasableSyntaxOnly` to keep this guaranteed.

`packages/emulator` depends on nothing vendor-specific; `core` stays zero-I/O and untouched; `runtime` is untouched — the entire system enters through the adapter-owned executable seam.

---

## 10. Phasing

| Phase | Contents | Exit | Status |
|---|---|---|---|
| **P1** | ASM format + validator in `packages/emulator`; adapter-claude as reference: distill `probe/captures` into `surface/model/claude@2.1.207`, migrate captures, `audit.mjs` | `registry.ts` generated from the model; audit diff clean against 2.1.207 captures | **delivered 2026-08-07** |
| **P2** | Channel simulators + scenario runner + claude `bin.mjs` (hooks + transcript first — they feed the reducer); conformance suite gains emulator mode | `adapter-claude` conformance green hermetically in CI | **delivered 2026-08-07** (engine + bin + `conformance.emulator.test.ts`; control server deferred to P3) |
| **P3** | `apps/emulator` control center + registration/control channel + godview emulator-mode flow | the §6.4 five-step flow works by hand | **delivered 2026-08-07** (scenario play-only — pause/step deferred; godview needs no changes, `CHOPSTICKS_CLAUDE_BIN` is the mode switch) |
| **P4** | Codex behavior pack (fake app-server promoted from the existing in-memory transport to a real subprocess) + the nightly reconciliation workflow; then grok/acp packs | nightly lane files (or doesn't) its first drift issue | |

P1 unblocks P2; P3 is independent of P4. Each phase is shippable and useful on its own.
