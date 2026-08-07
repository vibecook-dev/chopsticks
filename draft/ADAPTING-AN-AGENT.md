# Adapting a Coding Agent — the Standard Workflow

**Status:** Draft for review
**Created:** 2026-08-07
**Companion:** `draft/EMULATOR.md` (the surface-model format and emulator machinery this workflow produces and consumes), `draft/DESIGN.md` (canonical architecture), `draft/IMPLEMENTATION-PLAN.md` (what this generalizes: Phase 0/M2 for claude, C0–C6 for codex were this playbook played by hand)

---

## 0. Charter

> Adapting a new coding agent is a six-step pipeline with defined artifacts and machine-checked exit criteria at each step. The adapter package that results owns **four kinds of work**: truth-checking (`surface/captures/`, `surface/model/`, `audit.mjs`), emulation (`surface/emulator/`), the adapter itself (`src/`), and conformance wiring (`conformance.test.ts`). A new agent is "adapted" when all six exits are green — not when someone judges it done.

Two reference adaptations exist and define the families discovered so far:

| Family | Reference | Native surface |
|---|---|---|
| hook + transcript | `adapter-claude` | argv/settings → hook events (HTTP/command) + transcript JSONL + statusline |
| structured protocol | `adapter-codex` | JSON-RPC app-server (methods, notifications, server requests) + optional TUI attach |

A third family (e.g. ACP's negotiated-capability model — `adapter-grok` layers on it) reuses the same six steps; only the channel kinds differ.

---

## 1. The pipeline at a glance

| Step | Name | Output artifact | Exit gate |
|---|---|---|---|
| 1 | **Survey** | `surface/captures/` + findings doc | every channel the adapter will rely on has a capture; go/no-go per channel recorded |
| 2 | **Model** | `surface/model/<vendor>@<version>/` | ASM validates; every captured event has an event file with a confidence level |
| 3 | **Emulate** | `surface/emulator/` (bin, behavior, scenarios) | replay-diff against captures is clean; stub scenarios run standalone |
| 4 | **Adapt** | `src/` normalizer + driver + detection | registry/settings generated **from the model**; unit tests green against L0/L1 |
| 5 | **Conform** | `conformance.test.ts` + provider wiring | shared conformance suite green **on the emulator** in CI; live lane scheduled |
| 6 | **Reconcile** | nightly audit workflow | first reconciliation recorded; `lastVerified` current; drift triage loop proven |

Steps 1–3 establish truth; step 4 builds on it; steps 5–6 keep it true. **Never invert the order** — an adapter written from docs instead of captures repeats the pre-Phase-0 mistake (DESIGN's unverified hook-surface assumptions), and an emulator written from the adapter instead of the model makes the two wrong together.

---

## 2. Standard package layout

```
packages/adapter-<vendor>/
  package.json               # @vibecook/chopsticks-adapter-<vendor>, lockstep version
  src/
    detection.ts             # binary resolution + version + capability probe (model/detection.json)
    normalizer.ts            # native events → AgentEvent union
    driver.ts                # session lifecycle behind core's AgentSession
    index.ts
    conformance.test.ts      # runs the shared suite from @vibecook/chopsticks-testing
    *.live.test.ts           # opt-in real-vendor tests (nightly lane only)
  surface/
    model/<vendor>@<version>/
    captures/<vendor>@<version>/
    emulator/{bin.mjs, behavior/, scenarios/}
    audit.mjs
```

Registration in the product (per the repo's provider-seam convention): one `AgentProvider` entry in `packages/runtime/src/providers.ts` + one variant in `BuiltinCreateAgentSessionOptions` in `types.ts` — **never** provider-specific branching inside `runtime.ts`. Executable resolution honors `CHOPSTICKS_<VENDOR>_BIN`, which is also how emulator mode attaches (EMULATOR §4).

---

## 3. The six steps

### Step 1 — Survey

**Goal:** replace every assumption about the vendor's surface with an observation.

**Do:**
- Probe the binary: `--help`, `--version`, flag shapes, settings-schema acceptance (feed a generated settings file and observe accept/warn/reject).
- Census every candidate channel. Headless where possible; drive a real PTY (or the vendor's own attach protocol) for what headless can't produce — permission dialogs, interrupts, notifications.
- Keep raw captures verbatim under `surface/captures/<vendor>@<version>/`, one JSONL per event/method.
- Write the findings doc (`draft/<VENDOR>-SURFACE-FINDINGS.md`): verdict table, common envelope, per-event fields, adapter implications, open items.

**Exit:** each channel the adapter will rely on has at least one capture and a go/no-go verdict; known-unknowns are listed as open items, not silently absent. (Reference: HOOK-SURFACE-FINDINGS §1 verdicts, CODEX-SURFACE-FINDINGS §0.)

**Don't:** read vendor docs as truth. Docs are leads to verify — Phase 0 found DESIGN's hook assumptions wrong on arrival.

### Step 2 — Model

**Goal:** distill captures into the ASM (`surface/model/<vendor>@<version>/`, EMULATOR §2).

**Do:** `manifest.json`, `detection.json`, `channels.json`, one `events/<Event>.json` per observed event — `payloadSchema` from the captures (required = seen on every occurrence), `confidence` from how it was observed, `fixture` pointing at the capture file.

**Exit:** the ASM validator (`@vibecook/chopsticks-emulator`) passes; coverage check: every distinct event/method name in captures has an event file; every event file's schema accepts its own fixtures.

### Step 3 — Emulate

**Goal:** a scriptable stand-in for the vendor CLI (EMULATOR §4–5).

**Do:** behavior rules for the organic flows (paste → prompt events → transcript → stop), the required scenario set (happy turn, permission allow/deny, late/duplicate/out-of-order events, unknown event, flood, crash mid-turn, channel drop), and `bin.mjs` branching on argv like the vendor (incl. the detection surface).

**Exit:** replay-diff clean — replaying captures through the emulator produces channel outputs that match the captures; `bin.mjs` runs standalone (no control center) and passes the stub scenarios. Reference implementation: `packages/adapter-claude/surface/emulator/` (happy-turn behavior + crash-mid-turn scenario; the conformance suite runs against it hermetically).

### Step 4 — Adapt

**Goal:** the adapter itself, built on the model.

**Do:** detection reading `detection.json`; settings/registry **generated from the model** (never handwritten — the pre-ASM `adapter-claude/registry.ts` migrates to generated in P1); normalizer + driver behind core's `AgentSession`, honest `ObservationLevel` (DESIGN §19.2), unknown native events retained verbatim (ADR-008).

**Exit:** unit tests green against L0 scripted transports and the L1 emulator; zero references to vendor facts that aren't traceable to the model or a finding.

### Step 5 — Conform

**Goal:** prove the adapter honors the cross-agent contract, hermetically.

**Do:** wire `conformance.test.ts` to the shared suite (spawn → observe → state → inject → resume → dispose → no orphans, per DESIGN §26.2) **running on the emulator**; add the provider entry and the `BuiltinCreateAgentSessionOptions` variant; schedule the live lane (`*.live.test.ts` behind `<VENDOR>_LIVE=1`) in the nightly workflow.

**Exit:** conformance green in CI with no vendor binary present; the same suite passes against the real binary in the nightly lane; `pnpm pack:check` includes the new package (lockstep versioning — never hand-bump).

### Step 6 — Reconcile

**Goal:** keep all of the above true as the vendor evolves.

**Do:** `audit.mjs` (census → `surface-report.json` → diff vs model, EMULATOR §7) wired into the nightly workflow; triage loop: drift issue → update captures/model/fixtures → regenerate registry → bump `lastVerified`.

**Exit:** the workflow has run at least once; the first real drift (when it comes) is handled by the loop, not by rediscovery.

---

## 4. Machine-checked completeness

The conformance suite asserts the *process artifacts*, not just runtime behavior. An adapter package is complete when:

- [ ] `surface/model/` validates against the ASM schema, and every captured event is modeled
- [ ] `surface/emulator/bin.mjs` answers `detection.json`'s probes and serves the control API
- [ ] Required scenario set exists and replays clean against captures
- [ ] Registry/settings are generated from the model (no handwritten vendor facts)
- [ ] Shared conformance suite green on the emulator
- [ ] Live lane scheduled; `audit.mjs` wired into the nightly workflow
- [ ] Provider entry + `BuiltinCreateAgentSessionOptions` variant; no branching in `runtime.ts`

---

## 5. Where this came from

This playbook is a generalization of what the repo already did by hand: Phase 0 → M2 produced `adapter-claude` (steps 1–2, 4; its census lives in `probe/`, its registry encodes the model as TS data), and C0 → C6 produced `adapter-codex` (same shape against a structured protocol). The only new claims are: the artifacts become **formal** (ASM instead of findings-doc-plus-registry), the emulator becomes a **deliverable** instead of a test double, and reconciliation becomes a **standing lane** instead of a one-time spike.
