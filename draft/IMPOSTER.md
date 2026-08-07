# Chopsticks Agent Imposter — v0.1

**Status:** Draft for review
**Created:** 2026-08-07
**Companion:** `draft/EMULATOR.md` (the ASM format and captured-truth pipeline this consumes; its §3–§6 emulator machinery is what this replaces), `draft/ADAPTING-AN-AGENT.md` (the six-step workflow this shortens at steps 3 and 5), `draft/DESIGN.md` (canonical architecture)
**Supersedes:** `packages/emulator` and the per-adapter `surface/emulator/bin.mjs` pattern — the P2/P3 proof of concept, delivered and validated end to end on 2026-08-07, retired per §7

---

## 0. Charter

> One executable impersonates every agent. `ai --claude`, `ai --codex` — or, through installed shims, plain `claude` and `codex` on PATH. It speaks the vendor's real machine surfaces (hooks, transcripts, statuslines, JSON-RPC), connects itself to the control center over a Unix socket so it is discovered without registration bookkeeping, and adds a new vendor through data rather than a new executable.

---

## 1. What this changes, and what it must not

The proof of concept proved the semantic model works. It did so with **N per-adapter bins**, each reimplementing argv parsing, boot sequencing, channel wiring, and control registration; a stubbed terminal; and discovery through a state file plus two HTTP servers plus polling. This spec keeps the model and replaces the packaging.

| Concern | PoC | Imposter |
| --- | --- | --- |
| Executables | one `bin.mjs` per adapter | one `ai` CLI, N personas |
| Terminal channel | stub (`ADR-003` consequence, accepted) | shared cosmetic TUI (§4) |
| Discovery | state file → HTTP register → HTTP callback → 1.5 s poll | one UDS the plane owns; imposters dial in and hold (§5) |
| Adding a vendor | new executable + new behavior pack | persona data (§3) |
| Packages | `packages/emulator` (ASM runtime + engine + control, one name) | `packages/surface` (ASM) + `packages/imposter`; plane moves app-side (§7) |

### 1.1 The invariant (do not relitigate)

**Chopsticks never derives semantics from terminal text** (ADR-003/-004/-005). Introducing a real TUI is safe *only* because nothing downstream consumes it: godview renders those bytes for a human, and the reducer's inputs remain hooks, transcript, statusline, and JSON-RPC.

Therefore:

- The imposter's TUI is an **output-only channel**. The imposter's own tests may diff its frames; **no chopsticks package may assert on them**.
- The TUI is explicitly **not** a clone of any vendor's interface (§4). Vendor-interface parity is a stated non-goal, not a deferred phase.
- A test that proves a semantic by reading imposter screen text has crossed the line the emulator exists to defend. Treat it as a build failure, not a style nit.

### 1.2 Truth still flows one way

`EMULATOR.md §1` is unchanged: real CLI → captures → ASM → projections. The imposter is a *third* projection alongside adapter data and behavior packs. The ASM stays adapter-owned and capture-derived. Everything downstream of the model is emulation and moves into the imposter (§3.3).

---

## 2. The single timeline — one truth, two projections

The PoC's `bin.mjs` runs two independent paths: the behavior pack emits hooks and writes the transcript, and separately something writes stdout. They can disagree. With a real TUI they *will* disagree, constantly — and an imposter whose screen contradicts its hooks is worse than a stub, because it looks trustworthy.

A turn is therefore a sequence of semantic **ops**, each fanning out to both projections:

| op | claude (hook + transcript) | codex (JSON-RPC app-server) | presentation |
| --- | --- | --- | --- |
| `turn.start` | `UserPromptSubmit` hook | `turn/started` notification | prompt echoed |
| `assistant.delta` | transcript record | `item/agentMessage/delta` | streamed text |
| `tool.start` | `PreToolUse` hook | `item/started`, item type `commandExecution` | tool line, running |
| `tool.end` | `PostToolUse` hook | `item/completed` | tool line, resolved |
| `permission.ask` | `PermissionRequest` hook | a **server request** — method carried in the mapping | pending marker |
| `turn.end` | `Stop` hook | `turn/completed` | idle marker |
| `usage.refresh` | statusline invocation | `thread/tokenUsage/updated` | context readout |

(Method names verified against `packages/adapter-codex/src/normalizer.ts`. Codex approvals are deliberately generic — `driver.ts:137` passes the server-request method straight through as `tool`, so the imposter supplies the method rather than the adapter hardcoding one.)

This is `EMULATOR.md §1`'s "two projections, one truth" applied one level down. It buys three things:

1. **The screen cannot structurally contradict the wire.** Not a discipline — a consequence of there being one source.
2. **Scenarios become authorable at the op level.** Raw `emit` stays available for fault, duplicate, out-of-order, and unknown-event cases that must bypass the op layer by definition.
3. **Adding a vendor is a mapping.** Ops → that vendor's channel emissions. That mapping *is* the schema (§3.2).

The op vocabulary is deliberately small and semantic. It is not a superset of every vendor's events — anything not expressible as an op is written as a raw emission in a scenario.

### 2.1 Consequence for the mapping format

The two families discriminate differently, and this falls out of the table above: claude gives each op a **distinct event name**, while codex routes several ops through **one method** (`item/started`) and discriminates by item type in the payload. So `ops.json` cannot be a name lookup — each entry is a name *plus a payload template*:

```json
{
  "tool.start": {
    "channel": "jsonrpc",
    "method": "item/started",
    "with": { "item": { "type": "commandExecution", "command": "$op.command" } }
  }
}
```

This is the first thing the codex persona proves that the claude persona alone never would — which is precisely why §8 lands them together.

---

## 3. Personas

### 3.1 Layout

```
packages/surface/                       @vibecook/chopsticks-surface   (ASM runtime — §7.1)
  src/model.ts                          self-contained; erasableSyntaxOnly package-wide

packages/imposter/                      @vibecook/chopsticks-imposter
  bin/ai.mjs                            entry; resolves persona, then delegates
  src/
    cli/argv.ts                         persona from argv0 | --<vendor> | AI_PERSONA
    cli/shims.ts                        `ai shims install --dir <d>`  (§6)
    persona/load.ts                     ASM (adapter) + persona data → Persona
    session/timeline.ts                 the op timeline (§2)
    session/scenario.ts                 raw/adversarial layer beneath the ops
    session/channels/                   hook, transcript, statusline, jsonrpc, paste decoder
    control/{client.ts, protocol.ts}    UDS JSON-RPC client + shared message shapes (§5)
    tui/                                ONE shared Ink app; renderer only (§4.1.1)
  personas/
    claude/{persona.json, ops.json, behavior/, scenarios/}
    codex/{persona.json, ops.json, behavior/, scenarios/}
    synthetic/                          absorbs packages/testing/bin/fake-agent.mjs (§7.4)
```

Two packages, not one: §7.1 explains why the ASM runtime keeps its own compiler boundary.

### 3.2 The persona contract

Most of a persona already exists as ASM. That is the point — the adapter author has already done this work.

| Persona needs | Source |
| --- | --- |
| binary names, `--version` / `--help` output, flag names | `detection.json` — **existing ASM** |
| which channels to bring up | `channels.json` — **existing ASM** |
| event names + payload schemas | `events/*.json` — **existing ASM** |
| op → channel emission mapping | `ops.json` — **new**, per persona |
| boot op sequence | `persona.json` — **new**, per persona |
| stimulus → response, fault timelines | `behavior/`, `scenarios/` — existing, relocated |

A new agent therefore costs: the ASM the adapter needs anyway, plus an ops map and a boot sequence. There is **no chrome file** — see §4.

`persona.json` names its own ASM source so the imposter's dependency on adapter packages stays lazy and optional:

```json
{
  "vendor": "claude",
  "asm": { "package": "@vibecook/chopsticks-adapter-claude", "path": "surface/model/claude@2.1.207" },
  "shimNames": ["claude"],
  "boot": ["session.start", "instructions.loaded", "statusline.refresh"]
}
```

Adapters already publish `files: ["dist", "surface/model"]`, so a published imposter can resolve a published ASM. Note the resolution mechanic: adapter `exports` lists only `.` and `./package.json`, so the model is reached by `require.resolve('<pkg>/package.json')` and joining from its directory — the same trick `apps/emulator/src/main/spawner.ts` already uses to locate `bin.mjs`. Deep-importing `<pkg>/surface/model/...` directly will not resolve.

### 3.3 Ownership split

**Decided.** The ASM (`surface/model/`) and its captures stay adapter-owned — that is captured truth and `EMULATOR.md §9` is unchanged on it. Everything downstream of the model — ops, boot, behavior, scenarios — is emulation, and centralizes here. `audit.mjs` imports scenarios across the package boundary for the §7 reconciliation lane.

---

## 4. The TUI — cosmetic, shared, deliberately not a clone

**One chrome for every persona.** It conveys which agent is being impostered and enough operational readout to debug by. It is not themed per vendor and there is no fidelity ladder.

This is a goal, not a compromise. Cloning vendor interfaces would burn effort on the one surface chopsticks is forbidden to read, and would produce a screen convincing enough to invite exactly the mistake §1.1 prohibits. A screen that plainly announces itself as an imposter is the safer artifact *and* the cheaper one.

Content:

```
IMPOSTER · claude 2.1.207 · 5eb9761e · argv hook transcript statusline terminal
──────────────────────────────────────────────────────────────────────────────
22:29:06.879  UserPromptSubmit
22:29:06.984  Stop                     last_assistant_message: "emulator: ok"
22:29:17.573  PermissionRequest        Bash
──────────────────────────────────────────────────────────────────────────────
>
```

Banner, channel liveness, the live op/event stream, a prompt line that accepts paste. Nothing else. In practice this doubles as a local mirror of the control center, which is useful when debugging a session that has no console attached.

### 4.1 Stack: Ink 7

**Decided: Ink `7.1.1`.** Verified against the registry: `engines.node >= 22`, peer `react >= 19.2.0` / `@types/react >= 19.2.17`. The repo already pins `react ^19.2.7` and `@types/react ^19.2.17` — it drops in with no version negotiation and no new paradigm.

Ink is chosen for the **pinned layout**: header and prompt held in place while the event log scrolls between them. That is genuinely what a re-rendering framework is for, and hand-rolling it means alt-screen management, cursor positioning, and redraw-on-resize.

Note the rationale that does **not** apply: "Claude Code is built on Ink, so it looks closer." True, and irrelevant — §4 rules out parity.

### 4.1.1 Ink renders; it does not own input

Ink 7 ships a `usePaste` hook that enables bracketed-paste mode and delivers a paste as one string. **Do not use it.** The pipe path (§4.2) needs `createPasteDecoder` regardless, and adopting `usePaste` would mean two independent implementations of the one input path the adapter depends on — exactly the drift §2 exists to prevent, in the most load-bearing place.

Instead: take raw stdin through `useStdin` + `setRawMode` and feed the bytes to the **same decoder** both modes use; let its callbacks drive React state. Ink is then purely a renderer. This works because Ink enables bracketed-paste only while `usePaste` is mounted — without it, raw `\x1b[200~…\x1b[201~` arrives as ordinary data, which is precisely what the decoder expects. `useInput` is likewise unused, since it would otherwise interpret those bytes as keystrokes.

One paste path, pinned layout, no divergence between TTY and pipe.

### 4.1.2 Alternatives, and what accepting Ink costs

| Option | Why not |
| --- | --- |
| Plain stdout, append-only | Cheapest and would collapse §4.2's four modes to two — but gives up the pinned header and prompt. |
| OpenTUI | Requires Bun — a second runtime in a Node 22 pnpm monorepo. Its advantage is frame rate, meaningless for scripted output. |
| Rust / ratatui | What Codex actually uses, so highest parity for that persona — but parity is a non-goal, and a second toolchain cannot share the ASM types. |

Accepted costs, tracked rather than hidden: a dependency tree the repo did not previously carry; the four-mode matrix stays four (§4.2) because Ink cannot run without a TTY; and per-process memory rises. **Measure memory × N before the swarm demo** — the marginal cost over bare Node is smaller than Ink's ~50 MB headline, but N=20 deserves a number, and if it proves prohibitive the append-only fallback above is a contained retreat, since §4.1.1 already keeps input out of Ink's hands.

### 4.2 Four modes, all first-class

Only ghosttea gives the imposter a real TTY. Both `conformance.emulator.test.ts` (`stdio: ['pipe','pipe','inherit']`) and the control center's spawner (`stdio: ['pipe','ignore','inherit']`) use pipes, and Ink's raw mode requires `stdin.isTTY`.

| stdout | control socket | TUI | Control | Exercised by |
| --- | --- | --- | --- | --- |
| TTY | present | Ink | connected | godview + control center — the §6.4 flow |
| TTY | absent | Ink | standalone | `ai --claude` by hand in a terminal |
| pipe | present | none | connected | control-center spawner |
| pipe | absent | none | standalone | **CI / conformance** |

Headless is not a fallback — **CI runs it**. Treat it with the same discipline the PoC already applies to standalone mode: a first-class path with its own tests, or it breaks continuously.

---

## 5. Transport — invert the direction

**The plane owns one UDS; imposters dial in and hold the connection.** Node's `net` covers Unix domain sockets on POSIX and named pipes on Windows through one API.

This deletes the state file, the imposter's own HTTP server, the second bearer token, `prune()`, and the console's 1.5 s poll. Liveness becomes socket close — instant and correct rather than inferred from a failed round trip. The connection is bidirectional, so the plane can **push**: the console streams the emitted log instead of polling it.

### 5.1 Protocol

JSON-RPC 2.0, newline-delimited, either side may originate.

| Direction | Method | Notes |
| --- | --- | --- |
| imposter → plane | `session.hello` | vendor, sessionId, pid, cwd, channels, palette |
| imposter → plane | `session.emitted` | pushed per emission; supersedes `/log` polling |
| imposter → plane | `session.channels` | on change, e.g. after `channel-drop` |
| imposter → plane | `session.goodbye` | clean exit; socket close covers the rest |
| plane → imposter | `trigger` | ASM-validated, as today |
| plane → imposter | `scenario.run` | name or inline script, speed, stimulus |
| plane → imposter | `scenario.control` | `pause` / `step` / `resume` |
| plane → imposter | `fault` | crash, exit, hang, flood, channel-drop |
| plane → imposter | `state`, `log` | snapshot and backfill from a sequence |

`scenario.control` is the pause/step that `EMULATOR.md §10` lists as outstanding for P3. A held connection makes it straightforward — the runner awaits a gate between prepared steps.

The browser console keeps HTTP; it has to. The plane translates. Browser ⇄ HTTP ⇄ plane ⇄ UDS ⇄ imposter.

### 5.2 Two constraints worth writing down

- **Path length.** `sun_path` is ~103 bytes on macOS, ~107 on Linux. The socket must live at a short fixed path (`~/.chopsticks/imposter.sock`), never a nested per-session one.
- **Windows auth.** A 0700 directory gives POSIX a filesystem capability that named pipes do not expose through Node. **Keep a bearer token anyway** so both platforms behave identically; the token costs ~10 lines and the real win is that the endpoint was never network-reachable to begin with.

---

## 6. CLI surface

Persona resolution, in order: **argv0** → `--<vendor>` flag → `AI_PERSONA` env. Everything after persona selection is handed to the persona's argv parser, so the adapter's real launch recipe (`--session-id`, `--settings`, `--permission-mode`, …) is consumed exactly as the vendor would.

`ai shims install --dir <d>` writes `claude`, `codex`, … symlinks pointing at `ai`. Prepend that directory to PATH and **godview needs no changes at all** — the adapter's normal recipe finds `claude`, detection probes answer from `detection.json`, and the session spawns. `ai --claude` remains the ergonomic manual form.

`apps/godview/src/shim/agent-shim.ts` is the working reference: argv0 dispatch (`shimPath.split('/').at(-1)`), PATH cleaning to avoid recursion, `process.execve` replacement. Reuse its shape; note it is POSIX-only (`execve`), so the imposter's shims spawn rather than exec on Windows.

**Naming.** `ai` collides with the npm package `ai` and is a common shell alias. Publish as `@vibecook/chopsticks-imposter` with `bin: { "ai": …, "imposter": … }` and let the shims carry the real ergonomics.

---

## 7. Retiring `packages/emulator`

**Decided: the PoC package is retired.** Its problem was never the code — it was bundling three unrelated things under one name. Retiring it means splitting it correctly.

### 7.1 Why the ASM runtime does not move into the imposter

`model.ts` has consumers that are not the imposter: `surface/audit.mjs` (drift), `surface/generate-registry.mjs`, and `src/registry-render.ts` (which imports `SurfaceModel` as a type). `adapter-claude` currently carries `@vibecook/chopsticks-emulator` as a **devDependency**.

It must also stay **self-contained** — no relative imports, erasable syntax only — because `.mjs` surface scripts import it under node type stripping. `packages/emulator/tsconfig.json` enforces that today with `erasableSyntaxOnly` across the whole package. An imposter package containing Ink and JSX cannot set that flag, so the constraint would degrade from compiler-enforced to convention, and the failure would surface as a confusing `audit.mjs` break long after the offending import landed.

**A package boundary is how this constraint is enforced.** So the ASM runtime keeps its own home and its own compiler flag.

### 7.2 Disposition

| From `packages/emulator` | Goes to | Notes |
| --- | --- | --- |
| `model.ts` (whole file) | **`packages/surface`** — `@vibecook/chopsticks-surface` | Renamed package, same contents, same `erasableSyntaxOnly`. Adapters devDepend on it; the imposter depends on it. |
| `engine.ts` → paste decoder, hook emitter, transcript writer, statusline invoker | `packages/imposter/src/session/channels/` | May now import each other normally — the `validate`-injection existed only to keep the file self-contained. |
| `engine.ts` → scenario runner | `packages/imposter/src/session/scenario.ts` | Becomes the raw/adversarial layer beneath the op layer (§2, §2.1). |
| `control.ts` → `createControlPlane` | `apps/emulator/src/main/plane.ts` | Sole consumer; not published API. |
| `control.ts` → message shapes (palette, fault, scenario request, session view) | `packages/imposter/src/control/protocol.ts` | Shared by the imposter's client and the app's plane. |
| `control.ts` → `EmulatorSpawner` | stays in `apps/emulator` | The center's own spawn capability. |
| `ui/control.html` | `apps/emulator/ui/control.html` | Fix the two rendering defects found on 2026-08-07 (§7.4). |

**Deleted outright**, superseded by the UDS inversion (§5): `createEmulatorControlServer` (the bin-side HTTP server — imposters dial out and serve nothing), `defaultControlStateFile` / `parseStateFile` / `livePlaneInStateFile` (no state file), `registrationChannels` / `prune` (liveness is socket close), and the imposter-side bearer dance (the plane keeps a token for the browser).

`packages/emulator` is listed in `scripts/public-packages.mjs` at `0.1.8`, but it has **never been published**: it is new on the unmerged `feat/agent-emulator` branch, and `@vibecook/chopsticks-emulator` returns 404 from the registry (verified 2026-08-07). Retiring it is therefore free — no deprecation, no successor notice, no breaking change for any consumer.

The same holds for every rearrangement in this document. **Nothing described here has shipped**, so the usual constraints on moving published API do not apply, and the sequencing in §8 is chosen purely for bisectability rather than for compatibility.

### 7.3 Hard-won behavior that must survive the rewrite

These are the non-obvious parts of the PoC. They are cheap to lose in a rewrite and expensive to rediscover.

1. **Registration completes before stdin listeners attach.** Under `ELECTRON_RUN_AS_NODE`, a flowing stdin wedges later async I/O initiation and the register fetch never resolves (probed 2026-08-07). Ordering is load-bearing, not stylistic.
2. **Scenarios validate completely before the first side effect**, so a typo late in an inline script cannot leave a half-applied scenario behind.
3. **Off-model payloads are refused.** The imposter will not emit what its own ASM disallows — verified live returning `422 field "message" is number, expected string`. This is the property that keeps the imposter from teaching the adapter a lie.
4. **The curl-forwarder shape shortcut** (`FORWARDER_SHAPE`): the repo's own generated forwarder is recognized and delivered as a direct POST with identical headers and body — byte-identical at the bridge, independent of `sh`, which is what keeps command-transport events working on Windows.
5. **Transcript root isolation** — never `~/.claude`, so emulated sessions stay out of the user's real spaghetti index.
6. **Hook delivery fails soft.** A hook the bridge rejects, or a forwarder that cannot spawn, must not kill the process — real vendors fail the same way.
7. **The emission log is bounded** by both entry count and total bytes, with oversized entries truncated in place.

### 7.4 The other two stand-ins

| Artifact | Disposition |
| --- | --- |
| `packages/adapter-claude/surface/emulator/bin.mjs` | deleted at I4; `surface/model/` stays adapter-owned |
| `packages/testing/bin/fake-agent.mjs` (183 lines) | absorbed as a `synthetic` persona — removes the third stand-in and doubles as the deliberately-not-a-real-vendor check on the persona contract |

Two console defects to fix while moving `control.html`: Map-valued reducer state (`tools`, `permissions`, `subagents`, `tasks`) serializes to `{}` through `JSON.stringify`, so the console always reports zero tools in flight; and the empty-state placeholder is written with `innerHTML` and never removed once a session appears.

---

## 8. Phasing

Claude and Codex land **together**, before either is polished. A persona contract validated against one vendor comes out shaped like that vendor; claude (hook + transcript) and codex (JSON-RPC app-server + `--remote` attach) are the two families `ADAPTING-AN-AGENT.md §0` already identifies, and they are the test.

| Phase | Contents | Exit | Status |
| --- | --- | --- | --- |
| **I0** | Extract `packages/surface` (ASM runtime) out of `packages/emulator`. Nothing else moves. | `pnpm test` green, `surface:audit` clean, PoC still runs end to end | **done 2026-08-07** |
| **I1** | Imposter skeleton, channel modules, persona loader, op timeline, headless session, CLI. Both persona definitions authored. **No control channel yet.** | conformance green against `ai` instead of `bin.mjs` | |
| **I2** | Claude **and** codex runtimes — hook/transcript/statusline channels, and the app-server JSON-RPC channel | Both conform hermetically in CI; ops map cleanly onto both families, or the vocabulary is revised until they do | |
| **I3** | Control channel, both sides at once: UDS client in the imposter **and** the plane rewritten at its new home in `apps/emulator`. Delete state file, bin-side HTTP server, `prune()`, console poll. Push-based log. | §6.4 flow works over one socket; `scenario.control` pause/step lands | |
| **I4** | Ink TUI behind `isTTY`; `ai shims install`; delete `bin.mjs` and `packages/emulator`; absorb `fake-agent.mjs`; update EMULATOR.md + ADAPTING-AN-AGENT.md | godview panes show imposter chrome; no doc still describes per-adapter bins | |

I0 is a refactor that can land on its own and de-risks everything after it. I1–I2 are load-bearing. I3 is mostly deletion. I4 is chrome plus paperwork.

The control channel lands **whole** in I3 rather than client-first in I1, because a UDS client has nothing to dial until the plane is rewritten, and standalone is a first-class mode anyway (§4.2) — conformance runs the pipe-and-no-socket path, so I1 needs no control channel to prove itself. Until I3, `bin.mjs` and the frozen `packages/emulator` keep serving the control-center flow unchanged.

Because I0 leaves the PoC working, there is a green baseline to bisect against for the whole sequence — and if I2 reveals the op vocabulary is wrong for codex, only I1's timeline needs rework.

---

## 9. Non-goals

- **Vendor TUI parity.** Stated in §4 and repeated here because it is the requirement most likely to drift back in.
- **Emulating model quality.** Unchanged from `EMULATOR.md §8`.
- **A shadow process beside a live session.** ADR-002 stands; the imposter *replaces* a vendor binary and never accompanies one.
- **Removing the nightly reconciliation lane.** The imposter is a projection of captured truth. Only the real binary can detect drift.
