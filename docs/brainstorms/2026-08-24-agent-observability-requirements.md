---
date: 2026-08-24
topic: agent-observability
---

# Agent Observability

## Summary

A full observability layer for all agent activity across brain-kit and brain-ui: one server-side, OTel-aligned activity record (turns, tool calls, subagent runs, scheduled runs) that is streamed live to the UI where relevant, rendered by one trace-tree view anchored in the chat where the work happens, indexed by a first-class Activity surface, pushed as notifications on background failure, summarized as a "while you were away" digest, and queryable by the agent itself.

---

## Problem Frame

The stack runs agents in four shapes — interactive turns, parallel sessions, foreground subagent fan-outs, and scheduled cron jobs — and offers almost no way to see what any of them is doing. The triggering moment: multiple foreground subagents fanned out on research, and there was no way to tell whether real work was happening, what each subagent was working on, or how far along it was. The Agent tool call renders as a single opaque timeline entry.

The current workaround is asking the main agent to do post-mortem forensics over logs — which burns tokens, only works after the fact, and produces guesses rather than grounded answers. A code inventory confirmed the deeper pattern: the write side of observability partially exists (structured logs, counters, session cost accounting, cron run rows), but the read side is missing, and the richest signals are dropped in flight — per-model token usage and permission denials are discarded at the backend adapter, the per-turn result metrics are discarded by the client, per-tool-call timing exists only as in-memory client stamps that evaporate on reload, and scheduled agent runs record nothing beyond exit status and a stderr tail. Interactive and scheduled runs are disjoint worlds with no common record.

There is no production or release pressure; the mandate is the complete version, not an MVP.

---

## Actors

- A1. The user: single self-hosting person, checking on agent activity from the PWA (often a phone glance), and the operator of the same deployment.
- A2. Agent backends: pluggable turn executors (Claude Agent SDK default, pi alternative) that produce the activity being observed, including nested subagent runs.
- A3. Scheduled jobs: cron-driven runs (sync, validate, maintain, module jobs), some of which themselves run agents, with no chat surface attached.
- A4. The agent as consumer: the interactive agent answering questions like "what ran overnight?" by querying the observability record instead of scraping logs.

---

## Key Flows

- F1. Glance-check on running work
  - **Trigger:** A1 wants to know "is real work happening right now?" — possibly from a phone, possibly for a session that is not open.
  - **Actors:** A1, A2, A3
  - **Steps:** Open the Activity surface → see every live run (sessions, their subagents, scheduled jobs) with current step and elapsed time → tap any row to drill into its live trace view.
  - **Outcome:** Liveness, current activity, and progress are answerable in seconds without opening a chat session or reading logs.
  - **Covered by:** R11, R12, R14

- F2. Subagent drill-in from chat
  - **Trigger:** A turn fans out subagents; A1 wants to see inside one.
  - **Actors:** A1, A2
  - **Steps:** In the chat timeline, the Agent tool-call entry shows per-subagent status → tap opens that subagent's own timeline view (same trace-tree component), streaming live while it runs → breadcrumb returns to the parent turn; nested subagents recurse.
  - **Outcome:** The fan-out is transparent in place — no separate pane disconnected from where the work lives. The view is observation-only.
  - **Covered by:** R8, R9, R10

- F3. Background failure
  - **Trigger:** A scheduled run (or a turn running in a session the user isn't watching) fails.
  - **Actors:** A1, A3
  - **Steps:** Server records the failed run → push notification arrives on the device → tap deep-links to that run's trace detail with the failure highlighted.
  - **Outcome:** Failures surface themselves; nobody discovers a broken cron job days later by absence of output.
  - **Covered by:** R13, R15, R16

- F4. While you were away
  - **Trigger:** A1 returns to the app after time away.
  - **Actors:** A1, A3, A4
  - **Steps:** A scheduled digest job has summarized activity since the last visit from the activity record → the app surfaces the digest (what ran, outcomes, notable failures, spend) → items link into their run details.
  - **Outcome:** Catching up is a read, not an investigation.
  - **Covered by:** R17

- F5. Agent introspection
  - **Trigger:** A1 asks the agent "what happened overnight?" or "is anything still running?"
  - **Actors:** A1, A4
  - **Steps:** The agent calls the observability query tool → receives structured run/rollup data → answers grounded in the record.
  - **Outcome:** The post-mortem-by-forensics workaround is replaced by a cheap grounded query.
  - **Covered by:** R18

---

## Requirements

**Activity record**
- R1. Every unit of agent activity — turn, tool call, subagent run, scheduled run — is recorded server-side as a span in one canonical activity record, with parent/child linkage forming a tree (turn → tool call → subagent → its tool calls, recursively; a scheduled run is a root span).
- R2. Span naming and attributes follow the OpenTelemetry GenAI semantic conventions where they apply, so the record is OTLP-exportable later without remodeling.
- R3. Every span carries persisted start/end timestamps and a distinct outcome from a fixed taxonomy that includes at least: success, error, timeout, cancelled, and denied-by-user (approval declined is a first-class outcome, not a generic failure).
- R4. Spans record token usage (input, output, cache read/creation where the provider reports it) and monetary cost where the backend can price it. Usage data currently dropped at the Claude adapter (per-model usage breakdown, permission denials, error subtypes) is captured, not discarded.
- R5. The record survives reload and server restart: reopening a historical turn shows the same timings, outcomes, and usage as the live view did.

**Backend contract**
- R6. Usage reporting is part of the backend contract, not a Claude-only feature: every backend reports token usage per turn (pi included); cost is reported only where priceable, and absent cost is displayed as unknown, never as zero.
- R7. Baseline activity spans (turn, tool call, timing, outcome) are emitted host-side so any backend gets them for free; backends enrich with what they know (usage, model, subagent linkage).

**Chat drill-in (subagent visibility)**
- R8. The Agent tool-call entry in the chat timeline shows live per-subagent state: which subagents exist, their status, current activity, and elapsed time.
- R9. Each subagent opens into its own timeline view using the same trace-tree component as the main chat timeline — streaming live while running, complete afterwards — with navigation back to the parent context. Nested subagents recurse.
- R10. Subagent views are observation-only: no composer, no way to address the subagent.

**Activity surface**
- R11. A first-class Activity surface lists all agent activity — live and historical, across sessions, subagents, and scheduled runs — with status, duration, and outcome per row, failures highlighted.
- R12. The Activity surface is an index, not a residence: every row deep-links into the same trace/detail views the chat uses (a scheduled-run detail is the same trace view without chat around it). It never renders a disconnected copy of activity.
- R13. Scheduled runs get a run-history view per job (list of runs, status, duration, failure detail), covering every job name — including module jobs and jobs currently missing from status reporting.
- R14. Cost and token rollups (per session, per day, per job) are computed server-side and shown on the Activity surface — not as a meter in the chat composer.

**Scheduled runs**
- R15. When a scheduled job runs an agent, the full activity trace is recorded (tool calls, usage, outcome) — not just exit status and a stderr tail — and is reachable from the run-history view.

**Notifications and digest**
- R16. When a background run fails (scheduled job, or a turn in an unwatched session), the server sends a push notification to the PWA that deep-links to the failed run. Completion notifications are available opt-in per job or per run.
- R17. A "while you were away" digest summarizes activity since the user's last visit — what ran, outcomes, notable failures, spend — produced by its own scheduled job reading the activity record, surfaced in-app with links into run details.

**Agent access**
- R18. The agent can query the activity record through a tool: what is currently running, what ran in a given window, outcomes, and cost/usage rollups — the same data the UI reads.

**Streaming and authority**
- R19. All aggregation is server-side; the frontend never accumulates events to derive state or rollups. Live streaming is view-scoped: only events needed to paint what is currently on screen are pushed, and a client joining mid-run receives a snapshot of current state before deltas.

**Retention**
- R20. The activity record has a retention policy: recent activity keeps full span detail; older activity is pruned to durable rollups. The policy also bounds today's unbounded cron-run growth.

---

## Acceptance Examples

- AE1. **Covers R3.** Given a turn where the user declines a tool approval, when the turn completes, the tool-call span's outcome is denied-by-user and is displayed distinctly from an error.
- AE2. **Covers R5.** Given a completed turn with tool calls, when the app is reloaded and the session reopened, each tool call still shows its duration and outcome.
- AE3. **Covers R6.** Given a turn on the pi backend, when it completes, token usage is recorded and shown; cost displays as unknown, not $0.00.
- AE4. **Covers R8, R9.** Given a running turn that has spawned three subagents, when the user expands the Agent entry, all three appear with live status; opening one shows its own streaming timeline, and back-navigation returns to the parent turn.
- AE5. **Covers R16.** Given a scheduled sync job that exits with a failure, when the run is recorded, a push notification arrives whose tap opens that run's trace detail.
- AE6. **Covers R19.** Given a subagent view opened mid-run, when the client connects, it first receives a snapshot of spans so far, then live deltas — with no gap or duplication visible to the user.
- AE7. **Covers R15.** Given a scheduled job that runs an agent, when the run finishes, its run detail shows the agent's tool calls and token usage, not only an exit code.

---

## Success Criteria

- "Is real work happening, on what, how far along?" is answerable in under ~10 seconds from a phone, for any agent shape (turn, subagent, scheduled run), without opening logs or asking the agent.
- The post-mortem-by-chat workaround is dead: "what happened while I was away" is answered by the digest or one grounded agent query.
- No captured signal is silently dropped: usage, cost, denials, and timing visible in a live view are identical when revisited later.
- Background failures announce themselves via push within a minute of being recorded.
- Handoff quality: ce-plan can proceed to technical design (schema, protocol frames, push infrastructure) without inventing any product behavior, scope boundary, or outcome taxonomy.

---

## Scope Boundaries

- No eval/quality scoring (LLM-judge scores, datasets, annotation queues) — that serves prompt iteration, not visibility; revisit only if prompt experimentation becomes a practice.
- No external observability stack (Langfuse, Phoenix, Grafana/Tempo/Loki) — the OTel-aligned record keeps OTLP export open as a later config option, but shipping an exporter is not part of this work.
- No cost/token meter in the chat composer — rollups live on the Activity surface.
- Nothing multi-user: no per-user attribution, quotas, or team views.
- No interactive control of subagents from their views (steering, messaging, aborting individual subagents) — observation only in this scope.

---

## Key Decisions

- Hand-rolled activity record in the existing SQLite over embedding a self-hosted platform: dedicated stacks (6 containers, ~16 GiB RAM class) are disproportionate for a single-user deployment; adopting OTel GenAI naming preserves the export path at near-zero cost.
- Chat is the residence, Activity is the index: subagent and run views open in the context where the work lives; the Activity surface deep-links there and never becomes a parallel, disconnected dashboard.
- Server computes, client displays: rollups and derived state are server-side and persisted; the client is a viewer with view-scoped live updates. This also removes the existing class of client-stamped state that vanishes on reload.
- Real PWA web push for background failures, not in-app-only badges: the felt pain is being away from the app; in-app signals cannot address it. (Anthropic's own scheduled-task product currently lacks failure alerting — this is a gap worth closing, not parity.)
- Usage reporting is backend-agnostic by contract; cost is best-effort per backend. Tokens are the universal currency, price is provider-specific.
- The agent is a first-class consumer of observability (query tool over the same record) — directly motivated by the current workaround of agent-driven log forensics.
- The digest is its own scheduled job reading the record, not a side effect of instrumentation (matches industry practice; keeps instrumentation write-only and cheap).

---

## Dependencies / Assumptions

- The Claude Agent SDK tags subagent stream messages with parent linkage (`parent_tool_use_id`), making per-subagent demux feasible at the backend adapter. Verified against SDK typings during the brainstorm; exact coverage under the foreground-subagent execution path needs confirmation during planning.
- The pi SDK exposes token usage in some form (assumption — unverified; if it truly reports nothing, R6 degrades to "reports what the provider exposes" for pi and the gap is documented).
- Web push from the existing service worker is compatible with the current PWA/offline architecture (share-target handling already lives in the worker, so the worker seam exists).
- An `@opentelemetry/api`-shaped observability seam already exists in the server package with a console consumer; instrumentation attaches there rather than being built from scratch.
- SDK-native transcripts (JSONL) remain the source of truth for conversation *content*; the activity record is the source of truth for activity *structure and metrics*. The two link by session/turn identifiers but do not duplicate each other.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1, R19][Technical] Relationship between the new span events and the existing turn-scoped WS frames: enrich existing frames vs a parallel span-event channel, and how snapshot-then-delta works for late joiners.
- [Affects R1, R20][Technical] Span schema design (within the existing migrations story), rollup granularity, and the concrete retention windows.
- [Affects R8, R9][Needs research] How the foreground subagent execution path exposes per-subagent streams in practice, and how interleaved fan-out output is demuxed reliably.
- [Affects R16][Technical] Web push mechanics: VAPID key management, subscription lifecycle across devices, permission UX, and behavior when push permission is denied (fallback to in-app surfacing).
- [Affects R16][Technical] Failure-notification policy details: debouncing repeated failures of the same job, and whether a circuit-breaker (stop retrying, notify once) belongs in this scope or in the cron runner.
- [Affects R17][Technical] Digest generation: template-rendered from rollups vs agent-written summary, and its cost budget.
- [Affects R6][Needs research] What usage data the pi SDK actually exposes per turn.
- [Affects R18][Technical] Query tool surface: MCP tool vs CLI subcommand with `--json` (or both, per the "skills orchestrate, CLI executes" convention).
