# C0 — Codex Surface Findings

**Probed:** 2026-07-13, Codex CLI **0.144.2** (`codex-cli`), macOS (darwin), Node 24.14.1
**Method:** `codex --help` + subcommand help; `~/.codex` on-disk inspection; newest rollout record shapes; `codex app-server generate-json-schema --out` (structured protocol dump). Read-only — no live Codex session was spawned (interactive/live confirmations deferred, §6).
**Plan reference:** `IMPLEMENTATION-PLAN.md` §14 (M5). Companion to `HOOK-SURFACE-FINDINGS.md` (Claude Phase 0).

---

## 0. Headline

Codex is **not** a degraded, transcript-only agent. It has the **richest control surface of any agent we've surveyed**: a full JSON-RPC 2.0 **`app-server` protocol** (v2 schema, **516 definitions**) with structured turn control, streaming semantic events, and approvals as first-class request/response. The right chopsticks adapter for Codex is a **structured driver over the app-server**, not a PTY+transcript clone of the Claude adapter.

**Consequence:** M5 (second adapter) and M6 (structured/ACP driver) **collapse into one** for Codex, because Codex's *native* surface already is a structured protocol. Building it delivers the structured-driver architecture that Gemini/ACP later slot into.

The one thing Codex *lacks* that Claude has — a dictated `--session-id` — only bites the PTY path (Strategy A). Under the structured driver (Strategy B) identity comes back clean from `ThreadStartResponse`.

---

## 1. Verdicts

| Question | Verdict |
|---|---|
| Dictated session id at spawn (`--session-id` equivalent) | **NO** — Codex mints its own UUIDv7, embedded in the rollout filename and `session_meta.payload.session_id`. The PTY-path join must be **discovered**, not dictated. |
| Structured control protocol exists | **YES** — `codex app-server` speaks JSON-RPC 2.0 over `stdio://` \| `unix://` \| `ws://IP:PORT` (`--listen`). `generate-ts` / `generate-json-schema` emit versioned bindings → chopsticks can **codegen a typed client**. |
| Clean session identity via protocol | **YES** — `ThreadStartResponse.thread` is the thread id; `TurnStartParams` requires `{ input, threadId }`. No discovered-join race under Strategy B. |
| Structured (authoritative) streaming observation | **YES** — `ServerNotification` union (188 defs): `ItemStarted/CompletedNotification`, `AgentMessageDeltaNotification`, `TurnStarted/CompletedNotification`, `CommandExecOutputDeltaNotification`, `ProcessExitedNotification`, `FileChangePatchUpdatedNotification`, `ReasoningTextDeltaNotification`, `ContextCompactedNotification`, … |
| Structured prompt injection (no bracketed-paste guessing) | **YES** — `TurnStartParams.input` + `clientUserMessageId` → deterministic confirmation (echoed back on `ItemStarted/Completed`). Also `ThreadInjectItemsParams`, `TurnSteerParams`. **No `uncertain` receipt needed.** |
| Structured approvals (observe AND respond) | **YES** — approvals are JSON-RPC **ServerRequests** the client answers: `ExecCommandApprovalParams`, `ApplyPatchApprovalParams`, `FileChangeRequestApprovalParams`, `PermissionsRequestApprovalParams`, `CommandExecutionRequestApprovalParams`, `ToolRequestUserInputParams`. Real request-ids — strictly better than Claude's absence-pattern denial. |
| Native TUI + structured control on one session | **LIKELY** — `codex --remote <ws://\|unix://> --remote-auth-token-env <ENV>` attaches the TUI to a running app-server; `codex remote-control start/stop/pair` runs the daemon with a bearer/pairing token. (Mirrors chopsticks' own loopback+token bridge shape.) **Confirm live — §6.** |
| Structured resume / fork | **YES** — `ThreadResumeParams` / `ThreadForkParams` (protocol); `codex resume [SESSION_ID] [PROMPT]` / `--last` / `codex fork` (CLI). Resume by UUID, same as Claude. |
| Command-hook / notify callback (Claude-command-hook analog) | **YES** — `notify = ["<program>", "turn-ended"]` in `config.toml`: Codex invokes a program on events. Also a first-class **hooks** system (`--dangerously-bypass-hook-trust`; `HookStarted/CompletedNotification`, `HookEventName` in the protocol) and **MCP** (`codex mcp-server`, `[mcp_servers]`). |
| Transcript is spaghetti-readable (data-plane join) | **YES** — rollout JSONL under `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`; spaghetti's Codex `AgentSource` already reads it. `session_meta.payload.session_id` = the join key. |

**Go/no-go on the structured driver: GO (recommended primary path).** The PTY+transcript path stays as a degraded fallback / native-TUI-only mode.

---

## 2. On-disk shape (data-plane join — spaghetti already owns this)

```
~/.codex/sessions/2026/07/13/rollout-2026-07-13T10-06-31-019f5c71-…-fabf6.jsonl
```

Rollout record types (in order): `session_meta` → `event_msg` → `response_item`* …

`session_meta.payload` (the join + provenance):
```
session_id   019f5c71-d2ce-74c1-8041-771f7fcabfa6   (UUIDv7, == filename uuid)
cwd          /Users/.../infinite-canvas-engine
originator   codex-tui
cli_version  0.144.2
git          { commit_hash, branch, repository_url }
base_instructions { text }        # full system prompt inline
context_window { window_id }
```

`cwd` + `git.commit_hash` + `timestamp` are exactly the correlation keys a **discovered-join** would use under Strategy A. Under Strategy B we don't need them — `ThreadStart` hands us the thread id directly.

---

## 3. The two adapter strategies (the M5 fork)

### Strategy A — PTY + transcript + discovered join (Claude-parallel)
Spawn `codex` in a PTY; observe semantics via the rollout file (spaghetti reads it); discover the session id by watching for the new rollout after spawn (correlate `cwd`+`git`+time); inject via bracketed paste confirmed by the rollout's recorded user message.

- **Pro:** reuses the M1 PTY spine and the Claude adapter's exact shape; a genuine "maximally different agent, same adapter shape" abstraction test.
- **Con:** **deliberately throws away Codex's best surface.** Observation is poll-latency and lossy vs the structured stream; injection is back to `uncertain` receipts; permission prompts have no positive signal; discovered-join has a race if two sessions start in one cwd near-simultaneously.
- **Verdict:** keep only as the degraded fallback / native-TUI-only mode.

### Strategy B — app-server structured driver (RECOMMENDED)
Run `codex app-server --listen unix://<sock>` (or the `remote-control` daemon); `initialize` → `ThreadStart` → drive `TurnStart` / observe `ServerNotification` stream / answer approval `ServerRequests`. Optionally attach the **native TUI** to the same daemon via `codex --remote unix://<sock> --remote-auth-token-env`.

- **Pro:** authoritative low-latency observation; deterministic structured injection (`clientUserMessageId`); structured approvals with real request-ids; clean session identity; structured resume/fork; **and** the native terminal experience on the same session. Codegen'd typed client from `generate-ts`.
- **Pro (strategic):** delivers the DESIGN §M6 structured/ACP driver architecture *inside M5*. Gemini/ACP later reuse the `StructuredDriver` seam.
- **Con:** experimental protocol (versioned v1/v2, churns); needs the app-server lifecycle managed (spawn/daemon/pair/token); more moving parts than a PTY.
- **Verdict:** **primary path.**

---

## 4. What this does to the core abstraction

The core event union + reducer were shaped by Claude's **hook + transcript** model. Codex's **structured JSON-RPC** model is a second, structurally different driver behind the same intended `AgentSession` contract. Lifting the abstraction against *both* is the real generalization test (n=2, the right time). Concretely:

- `ObservationLevel` gains a tier **above** `native-hooks`: `structured` (authoritative streaming + structured approvals).
- The event union likely gains item/turn granularity it didn't need for Claude (`item.started/completed`, reasoning deltas) — that's the union earning its keep, not Claude-shape leaking.
- The **injector** abstraction gains a `structured` implementation (TurnStart/InjectItems, deterministic confirmation) beside Claude's `guarded-paste` one.
- The **join** becomes pluggable: dictated (Claude) / structured-response (Codex-B) / discovered (Codex-A).

---

## 5. Key CLI / config surface (reference)

```
codex [PROMPT]                       interactive TUI (native)
  -C/--cd <DIR>                      working root
  -s/--sandbox read-only|workspace-write|danger-full-access
  -a/--ask-for-approval untrusted|on-request|never
  --dangerously-bypass-approvals-and-sandbox
  --add-dir <DIR>                    extra writable roots
  --no-alt-screen                    inline mode (scrollback preserved)
  -c key=value                       TOML config override (dotted paths)
  --remote <ws://|unix://> --remote-auth-token-env <ENV>   attach TUI to app-server
codex exec [PROMPT]                  non-interactive (DO NOT use for native hosting — analog of claude --print)
codex resume [SESSION_ID] [PROMPT] | --last | --all
codex fork | archive | delete | unarchive
codex app-server --listen stdio://|unix://[PATH]|ws://IP:PORT
  app-server generate-ts --out <DIR> | generate-json-schema --out <DIR>
codex remote-control start|stop|pair [--json]
codex mcp-server                     Codex as an MCP server (stdio)
config.toml: notify=[program, "turn-ended"], [mcp_servers], approvals_reviewer
```

Regenerate the protocol contract any time:
```
codex app-server generate-json-schema --out <dir>   # v1 + v2 JSON Schema
codex app-server generate-ts --out <dir>            # typed bindings for the client
```

---

## 6. Deferred to a live/interactive probe (C1 spike)

Mirrors Claude Phase 0's interactive census — these need a running Codex, not `--help`:

1. **Identity join:** confirm `ThreadStartResponse.thread` (or its id) **equals** the rollout `session_meta.session_id` → preserves the spaghetti join contract (chopsticks knows the id ⇒ spaghetti indexes the rollout under it).
2. **`initialize` handshake:** exact params/capabilities; auth for `remote-control` (`pair` code vs bearer env); whether `unix://` needs a pre-created socket path.
3. **Native TUI + control coexistence:** `codex --remote unix://<sock>` attaches to the app-server daemon *and* renders the native TUI, with `TurnStart` driven from the protocol side — no double-drive / lease conflict.
4. **Notification stream capture:** one real `ThreadStart`→`TurnStart` turn → capture the `ServerNotification` sequence verbatim as fixtures (normalizer tests, conformance).
5. **`notify` contract:** exact event names + payload the `notify` program receives (the command-forwarder fallback shape).
6. **Sandbox/approval for write-capable runs:** `-s workspace-write -a on-request` behavior through the protocol (`ThreadStartParams.approvalPolicy`/`sandbox`).

Raw v1+v2 JSON Schema was dumped during this probe (regenerable via §5); not committed (471 KB v2, version-churning) — C1 codegens from a pinned regen instead.

---

## 7. C1 live spike — CONFIRMED (2026-07-13)

Drove `codex app-server` (stdio JSON-RPC) end-to-end against live Codex, read-only sandbox: `initialize` → `initialized` → `thread/start` → `turn/start("reply pong")` → `turn/completed`. **2.8 s, model replied `pong`, zero approval requests.** Capture + distilled shapes: `probe/codex/c1-appserver-capture.jsonl`, `probe/codex/c1-notification-shapes.json`.

**Verdicts (flips §6 deferrals #1, #4; partial #2):**

| Deferral | Result |
|---|---|
| #1 thread id ↔ rollout `session_id` ↔ spaghetti join | **CONFIRMED on disk.** `thread.sessionId` == `thread.id` == rollout `session_meta.session_id` (`019f5d86-…`). `thread/start` also returns `thread.path` = the rollout file path (handed to us, like Claude's `transcript_path` — no construction). **The chopsticks↔spaghetti join is a field on the ThreadStart response.** |
| #2 `initialize` handshake / auth | **Partial.** stdio app-server used James's `~/.codex/auth.json` directly — no extra auth. Handshake = `initialize`(requires `clientInfo{name,version}`) → server result carries `{userAgent, codexHome, platformFamily, platformOs}` → client MUST send the `initialized` notification before `thread/*`. `remote-control`/`pair`/bearer path still untested (only needed for the `--remote` TUI attach, C6). |
| #4 notification stream fixtures | **CAPTURED.** Sequence for one turn: `thread/started` → `turn/started` → `item/started`(userMessage) → `item/completed`(userMessage) → `item/started`(agentMessage) → `item/agentMessage/delta` → `item/completed`(agentMessage) → `thread/tokenUsage/updated` → `turn/completed`. Plus ambient `remoteControl/status/changed`, `mcpServer/startupStatus/updated`, `thread/status/changed`, `account/rateLimits/updated`. |

**Payload → core `AgentEvent` mapping (C2 preview):**

| Codex notification | Shape (key fields) | → core event |
|---|---|---|
| `turn/started` | `{threadId, turn:{id, status:"inProgress", startedAt}}` | `turn.started` (turnId = `turn.id`) |
| `item/completed` type `userMessage` | `{id, clientId, content:[{type:"text",text}]}` | user prompt echo — **`clientId` is the injection-confirmation channel** (set `TurnStartParams.clientUserMessageId`, match it here → deterministic, no `uncertain` receipt) |
| `item/agentMessage/delta` | `{threadId, turnId, itemId, delta}` | streaming assistant text (structured — carries `itemId`, unlike Claude's `MessageDisplay`) |
| `item/completed` type `agentMessage` | `{id, text, phase:"final_answer", memoryCitation}` | `assistant.message` (`phase` = `final_answer` \| commentary → the final/streaming discriminator) |
| `turn/completed` | `{threadId, turn:{id, status:"completed", durationMs}}` | `turn.completed` |
| `thread/tokenUsage/updated` | `{tokenUsage:{total,last:{totalTokens,inputTokens,cachedInputTokens,outputTokens,reasoningOutputTokens}}, modelContextWindow}` | token accounting — **per-turn tokens the rollout file can't give; spaghetti's Codex source shows `—` tokens, the protocol has them** |

**Protocol facts learned (corrections to §1/§5 assumptions):**
- Client method strings are `thread/start`, `turn/start` (also `turn/steer`, `turn/interrupt`, `thread/inject_items`, `thread/resume`, `thread/fork`). Full list dumped from `ClientRequest.json`.
- `ThreadStartParams.sandbox` is a **`SandboxMode` string** (`"read-only"`), **not** the `SandboxPolicy` object — sending the object errors `-32600 invalid value: map, expected map with a single key`.
- `ThreadStartParams.approvalPolicy` = `AskForApproval` string (`"never"` \| `"on-request"` \| `"untrusted"` \| `{granular:{…}}`).
- `TurnStartParams` = `{ threadId, input:[UserInput] }` where `UserInput` = `{type:"text", text}` (or image). Turn identity (`turn.id`) is returned on `turn/started`, distinct from `thread.id`.

**Still deferred (later phases, not blocking):** #3 native-TUI-via-`codex --remote unix://` coexistence with protocol-side `TurnStart` (C6); #5 `notify` payload (superseded by the protocol for observation); #6 write-mode approvals (`workspace-write` + approval `ServerRequest` round-trip — C4).

**C1 verdict: GO — the structured driver is real, identity-clean, and spaghetti-joinable.** Proceed to C2 (normalizer over these captures).

---

## 8. C6a — native-TUI coexistence probe (`--remote` over WebSocket)

Resolves §6 deferral #3, live against codex 0.144.2. Probes: `probe/codex/c6-ws-probe.mjs`, `c6-pty-attach-probe.mjs`.

**The socket transport is WebSocket, not NDJSON — on BOTH unix and TCP.** `codex app-server --listen` accepts `stdio://` (NDJSON), `unix://<sock>`, and `ws://IP:PORT`. Every *socket* transport (unix **and** TCP) frames JSON-RPC as **WebSocket**; only `stdio://` is NDJSON. Raw NDJSON/`Content-Length` to a socket gets silence (it's waiting for a WS upgrade). **WebSocket-over-UDS is verified** (`c6-ws-uds` probe: `HTTP/1.1 101 Switching Protocols` over the unix socket, then `initialize`/`thread/start`). **UDS is the preferred C6 transport** — no port allocation/collision, filesystem-permission scoped, not network-exposed. Gotchas: `--listen unix://` needs a **real path** (macOS `/tmp` is a symlink → the app-server's `lstat` rejects it with "not a directory"); the server logs "binds localhost only" and exposes `/readyz` + `/healthz`. **Localhost/UDS needs NO auth token** (the `--remote-auth-token-env` bearer is for remote/pairing access). Client note: Node's **built-in `WebSocket` is TCP-only**, so WS-over-UDS needs either the `ws` package (`ws+unix://`) or a ~70-line hand-rolled WS client (the probe proves it's small).

**Same JSON-RPC over WS.** `initialize → thread/start → notifications` behave exactly as stdio. `thread/list` → `{ data: [...] }`; `thread/read` → `{ thread: {...} }` (incl. the rollout path).

**The native TUI attaches and renders.** `codex --remote ws://127.0.0.1:PORT` under a real PTY (node-pty) renders the native Codex TUI (the `╭─ OpenAI Codex (v0.144.2) ─╮` banner, prompt, model/dir) — no auth, no errors.

**Coexistence CONFIRMED — the C6 model.** With a controller WS client AND the native TUI attached to the *same* app-server: the user types a prompt in the TUI → a new thread is created (`preview` = the prompt) → the controller observes it (`thread/list` picks it up, `thread/read` returns it, and it receives `thread/started` + `thread/status/changed` notifications). The TUI renders the assistant reply. **Native terminal + structured observation on one server, one thread.**

**C6 observation flow — CONFIRMED.** Broadcast notifications give a controller only thread-level events (`thread/started`, `thread/status/changed`), NOT the turn/item stream for a thread it didn't *initiate*. Subscription is **implicit**: there is no `thread/subscribe`, only `thread/unsubscribe`. `thread/resume {threadId}` returns the thread's history AND **opens the live stream** — verified (`c6-subscribe` probe): after the controller resumed a TUI-created thread, a second prompt typed in the TUI delivered the full stream to the controller (`turn/started → item/started → item/completed → item/agentMessage/delta → thread/tokenUsage/updated → turn/completed`). So the Model-B flow is: observe `thread/started` → `thread/resume` (history + live subscribe) → normalizer. This is a distinct lifecycle from `createCodexSession` (which `thread/start`s its own thread) → the adapter needs a **`createCodexObserver`** entry (shipped C6-2, live-tested).

**Materialization caveat (found building the observer):** a thread has **no rollout until its first user message** — `thread/resume`/`thread/read` right after `thread/started` error with "no rollout found" / "not materialized yet; includeTurns unavailable before first user message". So the observer **retries `thread/resume`** after `thread/started` until the first turn materializes the thread (a moment later), then observes forward. `thread/started` **does** broadcast to other connections (verified), so discovery is fine; only the resume must wait for materialization.

**C6 verdict: GO.** Model: chopsticks main spawns one `codex app-server --listen unix://<sock>` (UDS preferred over TCP — no port, filesystem-scoped), connects a **WS-over-UDS controller** (observe + inject), and the renderer PTY runs `codex --remote unix://<sock>` for the native display. Needs a **WebSocket-over-UDS `Transport`** for the app-server client — the injected-transport seam (C4) already supports this, so **no driver changes**, just a new transport implementation (`ws` pkg or the ~70-line hand-rolled client from the probe). §6 #3 resolved.

---

# C1b — Re-probe at 0.147.0 (2026-08-07)

**Probed:** 2026-08-07, `codex-cli` **0.147.0**, macOS 26.5.2 arm64. Live app-server sessions this
time (C0 was read-only). Design consequences live in `IMPOSTER.md §9`.

C0 already established the important architecture — `generate-json-schema`/`generate-ts`,
approvals as JSON-RPC ServerRequests with real request-ids, the structured-driver recommendation.
This section records only what is **new or corrected** three minor versions later.

## What changed since C0

| | C0 (0.144.2) | now (0.147.0) |
|---|---|---|
| v2 definitions | 516 | 557 |
| ClientRequest | — | **95 stable / 133 `--experimental`** |
| ServerNotification | — | **70 / 70 — all stable** |
| ServerRequest | — | 10 / 11 |
| schema files | — | 285 stable / 361 experimental |

Measured churn 0.146.0 → 0.147.0 (9 days): **+6 methods, 0 removed**, matching the release notes.
Additive, despite ~2 alpha tags/day.

## New findings

1. **Generation is deterministic** — a pure function of `(version, --experimental)`. Repeated runs
   byte-identical; fresh `CODEX_HOME` and explicit `--enable` of feature flags change nothing. So
   `EMULATOR.md §2.1`'s `git diff`-as-changelog promise holds for codex.
2. **`--experimental` is NOT purely additive.** 25 of the 285 shared files differ in *content* — it
   adds fields to stable methods. `CommandExecutionRequestApprovalParams` goes 13 → 15 properties,
   gaining `additionalPermissions` and **`availableDecisions`** (the vendor enumerating which
   decisions are legal, in the request itself). Commit both variants, or pick one and never mix.
3. **The schema is not the whole runtime surface.** `getAuthStatus`, `getConversationSummary`,
   `gitDiffToRemote` are accepted at runtime but absent from it (136 runtime vs 133 documented). An
   audit must not treat schema-absence as invalidity.
4. **`v1/`/`v2/` are Rust module names, not negotiated versions.** `v1/` holds only
   `InitializeParams`/`InitializeResponse`. `initialize` carries no protocol version at all.
5. **The wire is JSON-RPC 2.0-shaped but not conformant.** `jsonrpc` is omitted on server output
   (22/22 in the C1 capture) and tolerated on input (4/4 accepted). Generated `JSONRPCRequest`
   requires only `["id","method"]`. A strict JSON-RPC library will not work unmodified.
6. **The auth wall is exactly the model call.** `initialize`, `model/list`, `account/read`,
   `thread/start` and even `turn/start` all succeed with an empty `CODEX_HOME`; only the upstream
   `wss://api.openai.com/v1/responses` call 401s.
7. **A full turn runs offline** against a fake local model provider (`-c model_provider=fake`,
   `base_url=http://127.0.0.1:8899/v1`, `wire_api=responses`, junk key). Complete arc through
   `turn/completed`. **This makes the census hermetic and CI-able** — it resolves C0's §6 deferral
   without needing a live-credential lane.
8. **`codex exec --json` and `codex mcp-server` are worse capture surfaces** — different naming
   schemes (`thread.started` vs `thread/started`), fewer events, and no schema generator. Stay on
   app-server.

## Corrections to the adapter (all confirmed against the 0.147.0 schema)

C0's protocol reading was sound; the adapter built from it has since drifted.

- **Approval replies are malformed on every method.** `driver.ts:133-150` returns
  `{decision:'approved'|'denied'}` uniformly. `'approved'` is valid on 2 of 10; **`'denied'` on
  zero** (legacy deny is the object `{denied:{rejection}}`; current is `"decline"`); 6 of 10 have
  no `decision` field at all. `driver.ts:147` already carries an `UNVERIFIED` comment.
- **`localShellCall` (`normalizer.ts:180`) is not a real item type.** The 18 real ones are
  userMessage, hookPrompt, agentMessage, plan, reasoning, commandExecution, fileChange, mcpToolCall,
  dynamicToolCall, collabAgentToolCall, subAgentActivity, webSearch, imageView, sleep,
  imageGeneration, enteredReviewMode, exitedReviewMode, contextCompaction.
- **Two field reads can never resolve**: `normalizer.ts:194` reads `item.output` (real:
  `aggregatedOutput`); `:232` reads `item.result` (real: `results`).
- `clientUserMessageId` and `clientId` ARE real, so C0's deterministic-confirmation design is
  sound — but the round-trip was never exercised, and `driver.ts:239` returns `confirmed` on the
  `turn/start` promise alone without reading it.

## Privacy — `probe/codex/c1-appserver-capture.jsonl`

That capture is **committed raw to a public repo** (`origin/main` + 4 branches). It contains
`/Users/<user>/.codex`, hostname `<hostname>.local`, `installationId`, the prompt and
reply, and a `userAgent` carrying OS version and terminal emulator. No credentials. `.gitignore`
covers `packages/adapter-*/surface/captures-raw/` but not `probe/`.

Worse, the claude sanitizer **passes it clean** while leaving all of the above intact, because
`idKey` misses `threadId`/`itemId`/`callId` and codex has no `sensitiveContainer` equivalent. Two
constraints follow, neither retrofittable: widen the id set BEFORE the first capture (pseudonyms
are `sha256(value)`, so widening later rewrites every id in every fixture), and rewrite timestamps
— **codex ids are UUIDv7 and encode wall-clock capture time**, so aliasing alone does not anonymise
them.

## Still unobserved (C0's §6 item #6, still open)

The **approval round-trip has never been captured** — schema- and README-confirmed only. It is
where every adapter defect above lives, so it is the first scenario the census must produce.

## C1c — Hermetic harness groundwork (2026-08-08)

Probing toward the census harness. Two blockers from the earlier pass are
resolved; one remains.

**SOLVED — a hermetic turn now completes end to end.** The earlier attempt failed
with `stream disconnected before completion: failed to parse ResponseCompleted:
missing field 'total_tokens'`. A fake `responses` provider must send
`usage: {input_tokens, output_tokens, total_tokens}` — `total_tokens` is
required. With it, a turn runs offline through the full arc: `turn/started` →
`item/started`/`item/completed` (userMessage, agentMessage) →
`thread/tokenUsage/updated` → `account/rateLimits/updated` → `turn/completed`.
No account, no network, no tokens spent.

**SOLVED — the tool inventory.** Codex declares tools to the provider nested in
`input[0].tools` as *namespaces*, not a top-level `tools` array:

| namespace | tools |
| --- | --- |
| `functions` | `exec`, `wait`, `request_user_input` |
| `collaboration` | `followup_task`, `interrupt_agent`, `list_agents`, `send_message`, `spawn_agent`, `wait_agent` |

There is no `shell` tool in 0.147.0, which is why the earlier probe got
`unsupported call: shell`. `exec` is **`"type": "custom"`** — it takes a
`custom_tool_call` whose `input` is RAW JavaScript source, not a `function_call`
with JSON arguments. Nested tools reach the real capabilities:
`await tools.exec_command({cmd: [...]})`.

**UNSOLVED — eliciting a tool execution from a fake provider.** Four shapes
tried: `function_call` with JSON arguments; `custom_tool_call` with raw source;
each with and without a preceding `response.output_item.added`; and with the
item echoed into `response.completed.output`. In every case codex accepts the
stream and completes the turn cleanly, but emits only `userMessage` and
`agentMessage` items — the call is silently not executed, with no error.

RULED OUT (each tested against 0.147.0, all producing the same result — turn
completes cleanly, only `userMessage`/`agentMessage` items, no error):

1. Tool type — custom (`exec`) AND plain function (`request_user_input`).
2. Plan mode vs default mode.
3. Preceding `response.output_item.added`, present and absent.
4. The item echoed into `response.completed.output` vs an empty array.
5. `status: completed` on the item.
6. `--disable code_mode_host` — the declared tool list is unchanged, so
   `exec` is unconditional in this version.
7. Namespaced call names — `functions.request_user_input` and
   `functions_request_user_input`.
8. The `response.function_call_arguments.delta`/`.done` sequence the real
   streaming API emits for a function call.

The diagnostic that matters: **message items parse correctly** (the assistant
message from turn 2 always arrives) and codex proceeds to a SECOND provider
request after the tool call, so the stream is accepted rather than rejected. The
call is being silently discarded specifically in non-message item parsing.

**Consequence for the plan:** the hermetic lane can capture a full turn, token
usage and rate limits today, which is most of a behaviour census. Approvals and
tool items — the highest-value scenarios (IMPOSTER.md §9.7) — remain blocked on
the above. Recommended next move, and it is a BOOTSTRAP rather than a fallback: run ONE
credentialed turn that uses a tool, and record the provider's exact SSE bytes.
That yields the ground truth for the fake provider, after which the hermetic
lane replays those bytes forever at zero cost. Reading codex's own response
parser in openai/codex is the alternative, and is determinate rather than
guesswork — but the recorded bytes are useful regardless.

## C1d — The hermetic blocker, solved (2026-08-08)

**C1c was wrong about the layer.** It concluded the tool call was "silently
discarded specifically in non-message item parsing", and ruled out eight
hypotheses on that basis. All eight were probing the wrong thing: the item was
parsing correctly the whole time.

### How it was found

`strings` on the codex binary (210 MB, `@openai/codex-darwin-arm64`) shows the
parser logs `failed to parse ResponseItem from output_item.done` on a parse
failure — and that **`RUST_LOG` is honoured**. Running the existing probe with
`RUST_LOG=codex_core=debug` produced no parse error at all, and instead:

```
ERROR codex_core::tools::router: error=request_user_input is unavailable in Default mode
```

The call reached the **tool router**, which rejected it. The rejection goes to
the log and is never surfaced on the app-server protocol, which is why every
earlier probe saw a clean turn with no error. **A silent failure in the protocol
was a loud one in the log.**

The lesson generalises: probe a vendor with its own diagnostics turned on before
inferring behaviour from what its protocol does not say.

### The actual requirements for a tool call from a fake provider

1. `exec` is `"type": "custom"`, and its declared `format` is a **lark grammar**:
   the `input` is raw JavaScript source, evaluated in a fresh V8 isolate as an
   async module. Nested tools hang off a global `tools` object.
2. **Nested tool arguments are the trap.** `await tools.exec_command({cmd: [...]})`
   fails with `invalid type: sequence, expected a string at line 1 column 7` —
   `cmd` is a **string**, not an argv array. With
   `await tools.exec_command({cmd: "echo hi"})` the turn produces a real
   `commandExecution` item.
3. `namespace` on the item is **not** required (the hypothesis that came out of
   the `ResponseItem` field table was wrong; it parsed fine without it).
4. `request_user_input` is gated: *"unavailable in Default mode"*. There is a
   `tools.experimental_request_user_input` config key.

### The approval round-trip — CAPTURED (C0 §6 #6, open since 2026-07-13)

Trusted commands are auto-approved even under `approvalPolicy: "untrusted"`, so
`echo` never escalates. A **non-allowlisted** command does:
`sandbox: "read-only"` + `curl` produces
`item/commandExecution/requestApproval`.

```json
{
  "threadId": "…", "turnId": "…", "itemId": "exec-…",
  "startedAtMs": 1786207320888, "environmentId": "local",
  "command": "/bin/zsh -lc 'curl -s https://example.com'",
  "cwd": "…",
  "commandActions": [{ "type": "unknown", "command": "curl -s https://example.com" }],
  "proposedExecpolicyAmendment": ["curl", "-s", "https://example.com"],
  "availableDecisions": [
    "accept",
    { "acceptWithExecpolicyAmendment": { "execpolicy_amendment": ["curl","-s","https://example.com"] } },
    "cancel"
  ]
}
```

**The runtime sends `availableDecisions`; the stable schema does not declare it.**
An earlier draft of this section said it "ships on the stable surface, not just
under `--experimental` as C1b recorded" — that was wrong, and C1b was right.
Measured directly: stable declares 13 properties on
`CommandExecutionRequestApprovalParams`, `--experimental` declares 15 including
`availableDecisions`, and the wire carries it either way. This is C1b finding #3
again — the runtime surface is wider than the documented one — and it decides
which schema variant the ASM is generated from: **`--experimental`**, because a
model built from stable would omit a field the adapter must read.

The vendor enumerating its own legal decisions in the request is the useful
part: an adapter should read them rather than hard-code a table.

**`cancel` and `decline` are both accepted but are NOT synonyms:**

| reply | item status | turn |
| --- | --- | --- |
| `{"decision":"accept"}` | `failed`, `exitCode: 6` (sandbox blocked the network) | continues |
| `{"decision":"cancel"}` | `declined` | **ends** — no `agentMessage` follows |
| `{"decision":"decline"}` | `declined` | continues to `agentMessage` |

`decline` is absent from `availableDecisions` yet accepted, which is C1b finding
#3 again: **the enumerated surface is not the whole accepted surface**, in both
directions. For "deny this command but let the agent keep working" — the useful
default — `decline` is correct and `cancel` is wrong.

The completed item confirms two I3 corrections against real bytes:
`aggregatedOutput` (not `output`) and a real `exitCode`.

### Consequence

The census is now **fully hermetic**: turn, token usage, rate limits, tool
execution, and both approval outcomes, with no account and no tokens spent. The
credentialed bootstrap turn recommended at the end of C1c is **no longer
needed**.

### A leak the automated check could not see

Sanitizing the first census output produced a clean report while
`startedAtMs: 1786207526734` sat in the committed fixture. Every value-level
rule in the sanitizer operates on **strings**; a wall-clock timestamp is a
**number**, so it walked past all of them — while the UUIDv7 ids beside it were
being aliased into synthetic v4s specifically to destroy the clock they encode.
The redaction and the leak were the same fact, handled in one place and missed
in the other.

`SanitizerRules` gained `timestampKey`, with both halves — the redactor pins
matching numeric values to `REDACTED_EPOCH_MS` (2026-01-01T00:00:00Z, not 0, so
fixtures stay shape-faithful), and the detector reports an unpinned clock.

Turning the detector on immediately failed the repo's capture gate with **20
real leaks in `probe/codex/c1-appserver-capture.jsonl` and
`c1-notification-shapes.json`** — the files C1b flagged as committed raw to a
public repo. Both are now sanitized and the gate is clean. That is twice this
capture has been found leaking by a rule written for something else, which is
the argument for the sanitizer's deliberately broad defaults.
