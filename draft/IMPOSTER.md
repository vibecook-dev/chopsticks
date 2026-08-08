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

(Codex method names now come from the **vendor's own generated schema**, not from the adapter — see §9.1. That distinction is load-bearing: the adapter's method *names* all check out, but its item-type and approval-decision vocabularies do not, so citing it as the source would have propagated three confirmed errors. Codex approvals are generic on the adapter side — `driver.ts:137` passes the server-request method straight through as `tool` — so the imposter supplies the method.)

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
╭──────────────────────────────────────────────────────────────────────────────╮
│  ╭───╮  IMPOSTER impersonating claude 2.1.207                                │
│  │· ·│  session 5f0253c2  state ready                                        │
│  ╰~~~╯  argv · hook · transcript · statusline · terminal                     │
│ ──────────────────────────────────────────────────────────────────────────── │
│ 18:34:24.577  session.start                                                  │
│ 18:34:25.651  turn.start  "summarise the repo"                               │
│ 18:34:25.652  turn.end  "imposter: ok"                                       │
╰──────────────────────────────────────────────────────────────────────────────╯
 › 
```

Identity, lifecycle state, channel liveness, the live op stream, a prompt line that accepts paste. Nothing else. In practice this doubles as a local mirror of the control center, which is useful when debugging a session that has no console attached.

**Violet and blue, and a ghost.** The palette is a safety property, not decoration: Claude Code is orange and Codex is green, so an imposter that borrowed either would invite the confusion §1.1 exists to prevent. The chrome has to say *stand-in* from across the room, in a pane you did not launch yourself. The ghost's eyes follow the lifecycle, which is the one piece of personality this screen gets.

**The state on screen is not derived here.** It is the same `MachineSnapshot` the control console renders, pushed from the session (§11) — one truth, two projections, so the screen cannot describe a lifecycle the ops did not produce. Ops the persona binds to no channel are shown too, marked `(unbound)`: they happened, and said nothing.

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

Accepted costs, tracked rather than hidden: a dependency tree the repo did not previously carry; the four-mode matrix stays four (§4.2) because Ink cannot run without a TTY; and per-process memory rises.

**Measured 2026-08-08** (node 26.5, macOS arm64, RSS after module load):

| | RSS |
| --- | --- |
| bare node | 47 MB |
| imposter, headless | 77 MB |
| imposter, Ink loaded | 117 MB |

So Ink costs **~40 MB per process**. One imposter does not care; the swarm demo at N=20 is ~800 MB of chrome, since godview runs each imposter under a ghosttea PTY and every one of them therefore has a TTY.

Two things follow, both implemented:

1. **Ink is a dynamic import**, reached only after the TTY check, so a piped run — CI, and the control centre's own spawner — never loads React at all. A resolve-hook test asserts this rather than trusting it.
2. **`CHOPSTICKS_IMPOSTER_TUI=off`** forces the append-only sink even on a TTY. That is the contained retreat this section reserved, available without a code change.

`react-devtools-core` turns out to be an *optional* peer of Ink, so its 15 MB is not paid. Ink itself is 557 KB unpacked.

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

**Where the token lives (settled at I3).** Deleting the state file removed the only place a shared secret was published, so the plane writes one at `~/.chopsticks/imposter.token`, mode 0600, in the same 0700 directory as the socket. This is not the state file returning: it carries no URL, no pid, and nothing to infer liveness from, so there is no discovery parse surface and no ownership contention. The socket path is fixed, and socket close is liveness. The plane keeps a **second, separate** token for the browser console — two doors, two secrets, and the one on disk never reaches a URL.

**Stale sockets.** A socket file outlives an ungraceful exit, so existence is not ownership. The plane dials its own path first: something answers → another plane owns it, refuse to start; nothing answers → unlink and bind. This replaces `livePlaneInStateFile`.

---

## 6. CLI surface

Persona resolution, in order: **argv0** → `--<vendor>` flag → `AI_PERSONA` env. Everything after persona selection is handed to the persona's argv parser, so the adapter's real launch recipe (`--session-id`, `--settings`, `--permission-mode`, …) is consumed exactly as the vendor would.

`ai shims install --dir <d>` writes `claude`, `codex`, … symlinks pointing at `ai`. Prepend that directory to PATH and **godview needs no changes at all** — the adapter's normal recipe finds `claude`, detection probes answer from `detection.json`, and the session spawns. Those names shadow the real binaries, which is the point of that mode and the reason it is opt-in.

`ai link` is the other half, and the one to reach for first: it installs `ai` and `imposter` into `~/.chopsticks/bin`, which shadows nothing and is safe to keep on PATH permanently. See §11.1; the serve/interactive fork also comes from argv rather than from the persona.

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
| `packages/adapter-claude/surface/emulator/bin.mjs` | **deleted 2026-08-08**, with `conformance.emulator.test.ts` (the imposter runs the same shared suite) and `packages/emulator` itself; `surface/model/` stays adapter-owned |
| `packages/testing/bin/fake-agent.mjs` (183 lines) | **kept.** See below — the `synthetic` persona was built, the absorption was not. |

**Revised at I4 (2026-08-08).** The `synthetic` persona exists and earns its keep; folding `fake-agent.mjs` into it does not.

Two reasons. `fakeAgentBin` is exported API of `@vibecook/chopsticks-testing@0.1.8`, which **is** published — removing it is a breaking change for no gain. And the two do different jobs: the fake agent exercises the **terminal spine** (alt-screen, bad UTF-8, byte floods, ignored SIGINT, child process trees) for the PTY layer, while the imposter's TUI is cosmetic by §4 and deliberately does none of that. Merging them would conflate a terminal fixture with a machine-surface stand-in.

What §7.4 actually wanted — a not-a-real-vendor check on the persona contract — is delivered by `personas/synthetic/` alone, and it paid for itself immediately. Writing a second persona found three places the contract had quietly become claude-shaped:

- the envelope (`session_id`/`transcript_path`/…) was **hard-coded in the session**; it is now persona-declared (§3.2), as is the field the event name is written into;
- the ASM was assumed to live in an adapter package; a persona-local model is now legal, because a vendor that does not exist has no adapter to own its captures;
- channel drops were keyed by the imposter's internal delivery kind (`hook`) rather than the vendor's own channel name, so a `channel-drop` fault against a vendor that calls it something else **silently did nothing**.

The third was a live bug, not a design wart. That is the argument for keeping a synthetic persona permanently.

Two console defects to fix while moving `control.html`: Map-valued reducer state (`tools`, `permissions`, `subagents`, `tasks`) serializes to `{}` through `JSON.stringify`, so the console always reports zero tools in flight; and the empty-state placeholder is written with `innerHTML` and never removed once a session appears.

---

## 8. Phasing

Claude and Codex land **together**, before either is polished. A persona contract validated against one vendor comes out shaped like that vendor; claude (hook + transcript) and codex (JSON-RPC app-server + `--remote` attach) are the two families `ADAPTING-AN-AGENT.md §0` already identifies, and they are the test.

### 8.1 Codex has no ASM yet — and needs a different mechanism, not just a census

**Discovered 2026-08-07 during I1; researched the same day.** `packages/adapter-claude/surface/model/claude@2.1.207` is the *only* ASM in the repo. §3.2's claim that "the adapter author has already done this work" holds for claude and for nobody else.

The codex persona **must not be hand-written from `adapter-codex/src/normalizer.ts`**. `EMULATOR.md §1` names that exact failure: *emulator and normalizer must never be derived from the same unverified source.* That is not hypothetical here — the audit found the adapter answers all ten server-request approvals with `{decision:'approved'|'denied'}` when `'approved'` is valid on 2 of 10 and `'denied'` on **zero**; `normalizer.ts:180` switches on `localShellCall`, which is not one of the 18 real `ThreadItem` types; and `:194`/`:232` read `item.output`/`item.result` where the schema says `aggregatedOutput`/`results`. Building the imposter from the adapter would bake all of that in, and no test could see it.

Two findings changed the plan, both verified against the installed `codex-cli 0.147.0`:

1. **The binary emits its own protocol schema** (§9.1), so shape need not be inferred from captures.
2. **A full turn runs offline** against a fake local model provider, so the census is hermetic and CI-able rather than a live-lane gamble.

The full design is §9. The sequencing that replaces the old "blocked" note is §9.6.

| Phase | Contents | Exit | Status |
| --- | --- | --- | --- |
| **I0** | Extract `packages/surface` (ASM runtime) out of `packages/emulator`. Nothing else moves. | `pnpm test` green, `surface:audit` clean, PoC still runs end to end | **done 2026-08-07** |
| **I1** | Imposter skeleton, channel modules, persona loader, op timeline, headless session, CLI, claude persona. **No control channel yet.** | conformance green against `ai` instead of `bin.mjs` | **done 2026-08-07** |
| **I1.5** | Codex survey + model (§9). Ordered: capture envelope + sanitizer → committed harness → hermetic capture (approvals and tools FIRST) → `generate-model.mjs` → `surface/model/codex@0.147.0`. **Hermetic, not `CODEX_LIVE`** — a fake local provider drives a full turn offline. | Model validates; approval round-trip captured; harness committed; `diff(vendor schema, model)` clean | **done 2026-08-08** |
| **I2** | Claude **and** codex runtimes — hook/transcript/statusline channels, and the app-server JSON-RPC channel | Both conform hermetically in CI; ops map cleanly onto both families, or the vocabulary is revised until they do | **done 2026-08-08** |
| **I3** | Control channel, both sides at once: UDS client in the imposter **and** the plane rewritten at its new home in `apps/emulator`. Delete state file, bin-side HTTP server, `prune()`, console poll. Push-based log. | §6.4 flow works over one socket; `scenario.control` pause/step lands | **done 2026-08-08** |
| **I4** | Ink TUI behind `isTTY`; `ai shims install`; delete `bin.mjs` and `packages/emulator`; a `synthetic` persona (**not** an absorbed `fake-agent.mjs` — see §7.4); update EMULATOR.md + ADAPTING-AN-AGENT.md | godview panes show imposter chrome; no doc still describes per-adapter bins | **done 2026-08-08** |
| **I5** | The lifecycle machine (§11) and the console rebuilt around it; `ai link` + serve mode from argv (§11.1); `ai --claude` in a Godview pane (§11.2); the chrome redrawn — rounded frame, ghost, violet/blue | Clicking an op in the console transitions the graph and the reducer sees the traffic; the drawing cannot disagree with the machine | **done 2026-08-08** |

I0 is a refactor that can land on its own and de-risks everything after it. I1–I2 are load-bearing. I3 is mostly deletion. I4 is chrome plus paperwork.

The control channel lands **whole** in I3 rather than client-first in I1, because a UDS client has nothing to dial until the plane is rewritten, and standalone is a first-class mode anyway (§4.2) — conformance runs the pipe-and-no-socket path, so I1 needs no control channel to prove itself. Until I3, `bin.mjs` and the frozen `packages/emulator` keep serving the control-center flow unchanged.

Because I0 leaves the PoC working, there is a green baseline to bisect against for the whole sequence — and if I2 reveals the op vocabulary is wrong for codex, only I1's timeline needs rework.

---

## 9. The JSON-RPC family (codex)

Everything here was observed against `codex-cli 0.147.0` on 2026-08-07, or verified against the
schema that binary emits. Sources of each claim are marked.

### 9.1 The vendor emits its own protocol schema

```sh
codex app-server generate-json-schema --out <dir> [--experimental]
```

Exit 0, ~1s, **no auth, no network**. Output is a pure function of `(binary version,
--experimental)` — repeated runs are byte-identical; a fresh `CODEX_HOME` and explicit `--enable`
of feature flags change nothing.

| Union | stable | `--experimental` |
| --- | --- | --- |
| ClientRequest | 95 | 133 |
| ServerRequest | 10 | 11 |
| ServerNotification | **70** | **70** |
| ClientNotification | 1 | 1 |
| files | 285 | 361 |

**Every server notification is stable** — the surface the imposter *emits* is entirely the stable
half. Churn concentrates in client control methods, which it answers.

Three cautions, all verified:

- **`--experimental` is not purely additive.** 25 of the 285 shared files differ in *content*; it
  adds fields to stable methods (`CommandExecutionRequestApprovalParams` 13 → 15 properties,
  gaining `additionalPermissions` and `availableDecisions`). Commit both variants, or pick one and
  never mix.
- **The schema is not the whole runtime surface.** `getAuthStatus`, `getConversationSummary`, and
  `gitDiffToRemote` are accepted at runtime but absent from it (136 runtime vs 133 documented). An
  audit must never treat schema-absence as proof of invalidity.
- **`v1/`/`v2/` are Rust module names, not negotiated versions.** `initialize` carries no protocol
  version; the only signal is the binary's own, echoed in `userAgent` and `thread.cliVersion`.

Measured churn 0.146.0 → 0.147.0 (9 days): **+6 methods, 0 removed** — additive, despite a
~2-alpha-per-day tag cadence. Field-level churn is unmeasured and plausibly higher.

### 9.2 Shape from the schema, confidence from the census

This is the rule that keeps `EMULATOR.md §1` honest once the model is generated. If model ← schema
and adapter ← model and imposter ← model, everything agrees and nothing can detect a lie.

- **The vendor schema supplies shape** — properties, types, required. It is a *claim*.
- **The census supplies `confidence`, `fixture`, `firstSeen`, `lastVerified`** — evidence the thing
  actually happens, in that order, with those values.

**`generate-model.mjs` must be structurally incapable of writing `confidence`.** That single
constraint is what stops the imposter and the adapter from being wrong together.

Consequence — the drift equation gains a term, and codex ends up better instrumented than claude:

```
drift = diff(vendor schema, model)     ← mechanical, cheap, every codex release   (codex only)
      ∪ diff(real census, model)       ← evidential                               (claude has only this)
      ∪ diff(emulator behavior, model)
```

### 9.3 The op timeline does not cover this family — and should not be stretched

A hook imposter only emits. A JSON-RPC imposter must **serve**. Three properties each independently
break the timeline: it has no inbound path (`run()` returns `Promise<void>`); 95 client-request
methods (`fs/readFile`, `thread/list`, `config/read`) are an RPC service surface, not agent
semantics, and projecting them onto a 10-op vocabulary is a category error; and `initialize` is
enforced (`-32600 "Not initialized"`), so the server has a state machine the timeline cannot hold.

The split is clean, because all 70 notifications are stable:

| Duty | Volume | Mechanism |
| --- | --- | --- |
| emit notifications | 70 | **op timeline, unchanged** — one new channel sink |
| serve client requests | **~8 that matter**, not 95 | **new: serve table + dispatcher** |
| issue server requests, await reply | 10 | **one flag** on `OpBinding` + id correlation |

"~8 not 95" is what makes this tractable: the imposter need only be a codex app-server good enough
for *our* adapter. `driver.ts` calls `initialize`, `initialized`, `model/list`, `thread/start`,
`thread/resume`, `turn/start`; `observer.ts` adds `thread/list`, `thread/read`.

**The fork is the trigger, not the timeline.** For claude the trigger is stdin bytes
(`cli/main.ts`); for codex it is inbound RPC. The timeline runs downstream of the trigger in both
cases and is genuinely shared.

```
                       trigger                          projection
claude:  paste decoder ────┐
                           ├──► behavior ──► OP TIMELINE ──► sinks
codex:   RPC dispatcher ───┘                   (shared)
             │
             └──► synchronous reply, validated against resultSchema
```

`serve.json` carries the serve table and the state machine as data, per persona:

```jsonc
{
  "$server": { "gate": { "until": "initialize",
                         "error": { "code": -32600, "message": "Not initialized" } } },
  "initialize":   { "result": { "userAgent": "$vendorVersion", "codexHome": "$imposterHome" } },
  "thread/start": { "result": { "thread": { "id": "$uuid:thread", "status": { "type": "idle" } } },
                    "then": [{ "op": "session.start", "with": { "threadId": "$uuid:thread" } }] },
  "turn/start":   { "result": {}, "then": "$behavior" }
}
```

Server-initiated requests need no timeline surgery — `run()` is already async and `runAll` already
awaits sequentially, so an `"await": true` flag on the binding sends it as a server request and
binds the client's reply as `$response`:

```jsonc
"permission.ask": [
  { "channel": "appServer", "event": "item/commandExecution/requestApproval", "await": true,
    "with": { "threadId": "$threadId", "itemId": "$uuid:item", "command": "$op.command" } }
]
```

Three non-negotiables:

1. **Replies validate against `resultSchema` before they go out** — §7.3 item 3 applied to the
   reply direction. The `driver.ts:147` bug is the proof: an imposter doing this would have failed
   the first scripted approval.
2. **Inbound `params` validate against `payloadSchema`; a violation returns a JSON-RPC error, not a
   crash.** This makes the imposter a conformance test *of the adapter's client* — a capability the
   claude imposter structurally cannot have, and the strongest argument for doing codex properly.
3. **`then` schedules ops; it never writes the wire.** §2's "the screen cannot contradict the wire"
   survives only under that constraint.

### 9.4 `validatePayload` stays as it is

**803 of 812 top-level `v2` properties (98.9%) collapse into the existing flat subset**, 9
untyped/free-form, **zero** non-collapsing unions. Nesting is real (1,274 `$ref`s, 239 `oneOf`s,
depth to 11) but lives *below* the level `validatePayload` was ever meant to check.

So: **pre-flatten at generation time.** Extending the validator would mean draft-07 support, i.e.
a real JSON-Schema dependency, which breaks the dependency-free `erasableSyntaxOnly` constraint
that justifies `packages/surface` existing at all (§7.1). Two validators would split the drift
equation in half. Each generated event records `sourceSchema: {file, sha256}` so `audit.mjs` can
detect "the vendor changed something the flattening discarded" without storing a megabyte.

### 9.5 ASM delta — additive, zero migration for claude

| Field | Status |
| --- | --- |
| `kind: 'event' \| 'notification' \| 'client-notification' \| 'client-request' \| 'server-request'` | add, defaults to `'event'` |
| `resultSchema?: PayloadSchema` | add |
| `envelope?: { payloadPath?, discriminator? }` | add — `ThreadItem` has 18 variants |
| `sourceSchema?: { file, sha256 }` | add |
| `validatePayload`, `channels.json` format, `diffModelVsReport` | **unchanged** |

`confidence: 'unverified'` already suppresses `unobserved-verified`, so 95 generated-but-unexercised
client methods produce zero drift and get promoted as the census reaches them.

Method names contain `/`, which `loadModel`'s filename check rejects — needs a reversible slug
(`/` → `__`), with `loadModel` asserting reversibility and uniqueness.

### 9.6 Sequencing — two constraints that cannot be retrofitted

1. **Fix the capture envelope before capturing.** `buildReport` derives an event name from
   `hook_event_name` falling back to the filename (`model.ts:447-450`) — a claude accident, because
   hooks are self-describing. JSON-RPC messages are not: a response names nothing. **Only the
   process that watched the stream can pair a response to its method**, so the census must write
   `{"asmCapture":1,"event":…,"kind":…,"payload":…}`. One branch in `buildReport`; claude captures
   keep working byte-for-byte. Id pairing cannot be recovered afterwards from raw wire bytes.
2. **Write the sanitizer before the first capture.** Pseudonyms are `sha256(value)`, so widening
   the id-key set later rewrites every id in every fixture at once. `idKey` currently misses
   `threadId`, `itemId`, `callId` — and codex ids are **UUIDv7, which encode wall-clock capture
   time**, so they need regenerating as v4 (or v7 at a fixed epoch), not merely aliasing.

Then: committed harness → hermetic capture (approvals and tools first — they are the entire reason
to prefer codex over claude's absence-pattern) → `generate-model.mjs` → persona.

**The harness has been lost twice** — the C1 script was never committed, and claude's
`interactive-census.mjs` survives only inside `git show 1eea6db^:…`. Both times the output survived
and the tool that made it did not. Committing the harness is an exit criterion.

### 9.7 Observed at last (2026-08-08)

The **approval round-trip is captured**, hermetically: `captures/codex@0.147.0/approval-{accept,decline}.jsonl`. It had been schema-and-README-only since 2026-07-13.

What unblocked it was not a credentialed turn but `RUST_LOG`. Codex rejects a tool call in its **tool router** and reports that only to its log, never on the app-server protocol. Two sessions had concluded the item was failing to parse and ruled out eight hypotheses on that basis — all of them the wrong layer. See CODEX-SURFACE-FINDINGS C1d.

Three things the census settled, none of them guessable from the schema:

- `exec` is a **custom** tool taking raw JavaScript, and `exec_command`s `cmd` is a **string**, not an argv array.
- Trusted commands auto-approve even under `approvalPolicy: untrusted`; an approval needs a non-allowlisted command under a `read-only` sandbox.
- `cancel` and `decline` are both accepted but differ — `cancel` ends the turn, `decline` lets the agent continue. The adapters `decline` is therefore right, now on evidence rather than inference.

`codex exec --json` and `codex mcp-server` were both evaluated as alternative capture surfaces and rejected: different naming schemes, fewer events, and no schema generator.

**Still unobserved:** `item/fileChange/requestApproval` (the patch-approval path), MCP tool calls, and subagent activity. 70 of the 81 modelled methods are `unverified`, and say so.
---

## 10. Non-goals

- **Vendor TUI parity.** Stated in §4 and repeated here because it is the requirement most likely to drift back in.
- **Emulating model quality.** Unchanged from `EMULATOR.md §8`.
- **A shadow process beside a live session.** ADR-002 stands; the imposter *replaces* a vendor binary and never accompanies one.
- **Removing the nightly reconciliation lane.** The imposter is a projection of captured truth. Only the real binary can detect drift.

---

## 11. The lifecycle machine, and driving by op

**Landed 2026-08-08 (I5).** The ops in §2 were always a state machine — a turn cannot end before it starts, a tool cannot finish before it runs, an approval suspends whatever asked for it — but that structure lived only in the shape of the behavior packs, where nothing could see it. `packages/imposter/src/session/machine.ts` writes it down with xstate v5, and the same snapshot feeds the TUI and the control console.

```
starting ──session.start──▶ booting ──session.ready──▶ ready ──turn.start──▶ ┌ turn ─────────────────────┐
                                │                        ▲                   │ thinking ⇄ tool           │
                                └────turn.start──────────┘◀──turn.end────────│      ↘  ↙                 │
                                    (vendors with no                         │     approval              │
                                     readiness signal)                       └───────────────────────────┘
```

`session.end` (→ `ended`) and `usage.refresh` (a heartbeat that moves nothing) are handled at the root, so they are legal everywhere and are drawn as globals rather than as fourteen edges.

Three properties carry the design:

1. **Descriptive, never prescriptive.** The machine reports; it does not gate. An op the current state does not handle leaves the state alone and is counted off-model — it is *not* refused. Adversarial scenarios exist precisely to send traffic no organic turn would produce (`duplicate-out-of-order`, `late-after-exit`), and a machine that blocked them would delete the imposter's reason for existing. Refusal stays at the ASM boundary (§7.3 item 3), which judges payloads, not order.

2. **It advances on the op, not on the wire.** An op a persona leaves unbound still happened: codex binds no `session.ready`, and the imposter is nonetheless ready. The machine therefore describes what the imposter *is*, while the emitted log describes what it *told* the client — and the gap between them is exactly what an adapter author needs to see. The console draws it directly: an unbound op is dashed in the op palette.

3. **`booting --turn.start--> turn` is a real edge, not a convenience.** A vendor with no readiness signal proves readiness by completing a turn, which is what the codex reducer does on the first `turn/completed`. Without that edge every codex turn would read as off-model, which would be a lie about codex rather than a finding about it.

**Raw events do not advance it.** Scenarios and the console's event palette write to the wire without an op, so the graph deliberately stays put while they run. That is the honest split, and it is why the console now leads with **ops** — the organic control — and keeps raw events, scenarios and faults behind an "adversarial" disclosure.

**One picture, no copy.** `describeMachine()` returns nodes, edges, globals and hand-authored layout; the plane serves it at `GET /api/machine` and the console draws whatever it is given. A test walks every state against every op in both directions and fails if the drawing and the machine disagree, so the picture cannot drift from the thing it pictures. Layout lives beside the machine because this graph is small, fixed, and worth reading — a generic layout engine would spend a dependency to produce something worse.

**Cost.** xstate v5 imports in 6 ms for 5.6 MB RSS (node 26.5, measured 2026-08-08) — an eighth of Ink's 40 MB, and unlike Ink it is wanted in every mode, so it is a static import rather than a dynamic one.

### 11.1 CLI: `ai link`, and serve mode from argv

Two changes make `ai` a command you can actually run.

**`ai link`** installs `ai` and `imposter` into `~/.chopsticks/bin` — a directory that shadows nothing, so it is safe to leave on PATH forever. `ai shims install` keeps writing *vendor* names into `~/.chopsticks/shims`, which does shadow the real binaries wherever it is prepended; that is the point of it, but it is now a separate, clearly-labelled act rather than the only way to reach the tool.

**Serve mode comes from argv, not from the persona.** `serve.json`'s `$server.command` names the vendor subcommand that turns the binary into a server, and the fork is taken only when argv asks for it: `ai --codex app-server` speaks the protocol, bare `ai --codex` opens the shared chrome. The real vendor works exactly this way, and an imposter that always served failed the most visible faithfulness test there is — you could not run it by hand. A serve persona run interactively reports its app-server channel **detached**, because nothing is attached to it; the ops run and reach no wire, which is the truth of the mode.

### 11.2 Godview panes

`ai --claude` typed in a Godview pane now produces a session Godview recognises as claude, rendering the imposter's own chrome. The pieces:

- Godview's shim directory gains an `ai` entry. The shim reads its own name, takes the vendor from `--<vendor>`, strips that flag, and marks the request `imposter: true`.
- `ClaudeAgentOptions.executable` overrides the binary **for one session**, so every other pane still launches the user's real Claude Code. `CHOPSTICKS_CLAUDE_BIN` is the same capability applied to the whole process, which is exactly what makes it unusable here.
- The gateway resolves the imposter itself (PATH, or `CHOPSTICKS_IMPOSTER_BIN`) and merges `AI_PERSONA` into the launch env. A request can choose emulation; it can never choose what gets executed.

**Only claude, and for a specific reason.** The codex adapter's TUI recipe spawns `codex app-server --listen unix://…` and attaches a second process over a WebSocket on that socket, while the codex persona serves NDJSON on stdio. Until the persona speaks that listen/attach pair, `ai --codex` in a pane is refused with a message saying so — an honest refusal beats a session bound to nothing, which would look like it worked.

### 11.3 Two input bugs, found by running it

Neither showed up in any suite, because both live in the gap between a pipe and a real terminal — and the conformance tests, correctly, use a pipe.

**The imposter never enabled bracketed paste.** A terminal emits `ESC[200~` markers only for an application that has turned DECSET 2004 on. Real TUIs do; the imposter did not, so a pane pasted bare bytes and the decoder — built entirely around those markers — never saw a paste. The pane's prompt did nothing at all, and the adapter's reducer sat at seven events. `ai` now enables the mode on an interactive TTY and restores it on exit.

**Enter that arrives late fell on the floor.** The decoder holds a completed paste for 15 ms and then releases it as staged; terminal automation commonly writes the paste and the newline separately, so the newline arrived after the hold expired and was discarded. The prompt line now keeps staged text across operations, and a bare Enter submits it — which is what every prompt does. The decoder itself stays a pure byte splitter.

While fixing the second, the prompt line gained the minimum a real terminal needs: typed characters accumulate and backspace deletes. That is a prompt line, **not** a line editor — anything more is the vendor parity §4 rules out — but a screen in front of a person where typing does nothing is not a screen.

**Verified in a pane:** `ai --claude` → adopted as claude → prompt → `lastAssistantMessage: "imposter: ok"`, lifecycle back to `ready`, eleven native events observed by the real adapter.

**Known gap.** `conversationSnapshot().items` stays empty for an imposted claude session, so a chat panel fed by the conversation projection shows nothing even though the reducer sees the whole turn. The transcript records the imposter writes are correctly claude-shaped and the adapter watches the path the hook envelope gives it, so the cause is further in than this work reached. Pre-existing, and unrelated to §11's three changes.
