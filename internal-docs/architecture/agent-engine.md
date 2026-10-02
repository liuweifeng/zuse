# Agent Engine

The Agent Engine is the server subsystem that owns agent sessions. It keeps a
durable graph of what the user asked for and what each provider did about it,
treats every provider as a replaceable backend, and runs every provider
interaction as a durable job. Clients render projections of that graph and
never infer state from a live process.

## Implementation status

This document describes the target architecture, not a guarantee provided by
the current runtime. The branch implements the transactional
job ledger, provider-thread rows, turn rows, attempt history in the event-sourced
aggregate, and `activeTurn` timeline projection. These cover slices 1–3, with
reliability gaps still to close before treating those slices as complete.

Production persistence now acquires a process-lifetime SQLite lock before database
migration and runtime construction. A second engine for the same data directory
fails before reconciliation; process death releases ownership without stale-file
stealing. Linux process tests cover contention, suspension and forced termination.
Native macOS and Windows validation is still outstanding.
Jobs now use renewable claims with unique acquisition owners, expiry recovery,
post-commit cancellation, and session-scoped command drains. Provider sends retain
a durable delivery fence: an uncertain outcome is surfaced instead of resending.
Provider-thread identity is scoped to its owning session; forks sharing a native
handle keep separate heads, including through historical replay and migration.
Provider send and interrupt jobs now carry attempt identity. Obsolete jobs are
skipped, retry cancels earlier sends and interrupts, and job settlement uses a
transactional ownership guard. A migration recovers historical job ownership
from the causing event. Attempt-aware provider handles now have immutable ownership
and are replaced when a new attempt resumes the native thread. Their event envelopes
carry ownership through message persistence, settlement, permission changes and
thread binding. Final resume cursors may update the newest completed attempt until
a later turn starts. Cursor deliveries carry process-local acknowledgment and
release authority bound to the emitting handle. Persistence acknowledges that
handle only after commit; rejected or interrupted persistence and unfinished
streams release its pending delivery. Replaced handles cannot attach new question
callbacks.
Provider attachments and stop jobs now carry a unique live provider-session
identity. Delayed stops retire only that identity and cannot detach a replacement,
including a newer process for the same provider. Historical stops without an
identity cannot target newly identified handles. Stop cleanup retains the retired
handle through cancellation. The domain now supports durable startup reservations
and transactional reservation guards, including rejection of receipt replay after
revocation. Stop requests target both the attached handle and a distinct pending
reservation. A session-row projection now supports ownership checks by primary key,
and migration rebuilds it from lifecycle history. Runtime startup reserves its
identity before workspace resolution or driver acquisition. Pending registry
entries carry that identity; admission and attachment/status publication check
both durable ownership and physical generation. Failed or cancelled startup
revokes and closes only its own identity. Maintenance startup cannot replace an
active attempt. Provider deliveries carry the emitting residency identity; event
admission and transactional message, permission, cursor and settlement writes
reject revoked identities even while the same attempt remains active.
Stop-before-reservation, physical send races, and process-local question/goal
callbacks still need end-to-end fencing.
Job status and failure-message writes now carry transactional attempt guards,
and interrupt cleanup closes only the matching provider handle. Handles whose
event stream ended before the first send reject work as undelivered and are
retired for recovery. Startup admission checks durable ownership under lifecycle
serialization before replacing a handle, and owned attach/status publication checks
ownership inside the transaction. Startup scopes retain displaced and acquired
handles until successful publication and return; cancellation closes only those
handles, with bounded cleanup and generation-aware invalidation. Driver acquisition
before a handle is returned and legacy unowned lifecycle paths still need a recovery
audit. Uncorrelated drivers currently require
a fresh handle per attempt, adding resume latency; reuse requires native event
correlation.
Durable input requests, step ownership, context handoffs, detached desktop runtime,
and server-owned liveness remain targets.
The current SQL turn projection stores the latest attempt; it is not a queryable
history of all attempts. Contracts for later entities do not imply runtime support.

Delivery should follow the outcome groups below. The numbered slices remain a
mechanism inventory, not an instruction to defer recovery until slice 9.

The pipeline in `realtime-runtime.md` stays. What changes is what flows through
it: turns, attempts, steps, provider threads, input requests, and jobs instead
of a single current turn and a resume cursor. Decisions are recorded in ADR
0005.

## The graph

```text
Session                            user-visible conversation, app id
  Turn (ordinal 1..N)              one counted user turn
    Attempt (1..M)                 one provider execution of that turn
      root Step                    kind=root, completesTurn=true
        tool_call step
        approval step ------------ InputRequest {answerability}
        subagent step ------------ child Session (lineage=subagent) or child ProviderThread
  ProviderThread handles           provider-native conversations, several over time
  ProviderSession                  live process residency, never resurrected
  ContextLink / ContextHandoff     fork, provider switch, merge-back, subagent result
  CheckpointScope / Checkpoint     git refs per turn ordinal
  Jobs                             durable provider work with leases and retries
```

The graph is the durable truth. A provider process is a cache of live state
that may be released, crash, or be replaced at any time without the session
losing anything.

## Rules

1. App ids are primary. Provider ids are refs (`ProviderRef {provider,
   nativeId, strength}`) and never keys.
2. Only the root step of the active attempt completes a turn. A child step
   finishing never closes its parent. An interrupt acknowledgement is never
   the terminal event; the provider's terminal is.
3. Every provider interaction is a job committed in the same transaction as
   the events that requested it.
4. Missing provider capability is an explicit, typed policy outcome. Nothing
   outside a driver branches on `ProviderId`.
5. Provider switches, forks, merge-backs, and subagent results are
   `ContextLink`s. Expensive handoff text is materialised lazily when the
   consuming turn starts and is stored as an auditable `ContextHandoff`.
6. Ids that can be observed twice are derived from their scope and native id,
   so a second observation is an upsert.
7. Liveness is derived from the graph (active turn, open background steps,
   pending live requests), never from a status column or an in-memory handle.

## Entities

Schemas live in `packages/contracts/src/agent-engine.ts`.

| Entity | Carries | Status |
| --- | --- | --- |
| `Turn` | `ordinal`, `provider`, `providerThreadId`, `activeAttemptId`, `queuePosition`, `checkpointId`, `contextHandoffId` | `preparing, queued, starting, running, finalizing, completed, interrupted, failed, cancelled, rolled_back` |
| `Attempt` | `ordinal`, `rootStepId`, `providerTurnId`, `reason: initial, steering_restart, retry, provider_recovery`, lease | `pending, running, completed, interrupted, failed, cancelled, superseded` |
| `Step` | `parentStepId`, `rootStepId`, `kind`, `completesTurn`, `nativeItemRef`, `inputRequestId`, `checkpointScopeId` | as turn, minus `queued` |
| `ProviderSession` | `provider`, `cwd`, `model`, `capabilities` | `starting, ready, running, waiting, stopped, error` |
| `ProviderThread` | `nativeThreadRef`, `nativeHeadRef`, `firstTurnOrdinal..lastTurnOrdinal`, `handoffIds`, `ownerStepId`, `backgroundTasks` | `not_loaded, idle, active, archived, closed, error` |
| `ProviderTurn` | `nativeTurnRef`, `ordinal`, `attemptId`, `tokenUsage` | `pending, running, completed, interrupted, failed, cancelled` |
| `InputRequest` | `kind` (permission, question, plan_approval, tool_callback, auth_refresh), `answerability: live \| expired` | `pending, answered, expired, cancelled` |
| `Subagent` (id is a `StepId`) | `origin: provider_native \| app_owned`, `childSessionId`, `nativeTaskRef`, `completionWake` | `pending, running, waiting, completed, failed, cancelled, interrupted` |
| `ContextLink` | `type`, `sourcePoint`, `basePoint`, `resolution` | `pending, resolved_native, resolved_portable, failed, consumed, superseded` |
| `ContextHandoff` | `coveredTurnOrdinals`, `strategy`, `summaryText` | `pending, ready, failed, superseded` |
| `CheckpointScope`, `Checkpoint` | `kind`, `advancesTurnCount`, `cwd`; `ordinalWithinScope`, `turnOrdinal`, git `ref`, `files` | `ready, missing, error, stale` |
| `TimelineItem` | ordered row with refs back into the graph; `ordinal` is banded per turn | `pending, running, waiting, completed, failed, cancelled, interrupted` |

Messages and timeline items are projections. Turns, attempts, steps, provider
threads, and input requests are the canonical graph.

## Command pipeline

```text
dispatch(command)
  per-session serial lock
  receipt lookup by commandId          -> replay the stored result, run nothing
  decide(command, state)               -> events
  one SQLite transaction:
    append events (global sequence)
    apply projections
    enqueue jobs implied by the events (no notification yet)
    finalise receipt
    cancel unsettled jobs if requested
  after commit: signal cancellations, notify the job worker, publish to subscribers
  return {sequence}                    -> the client's reconnect cursor
```

Entity events are snapshots (`TurnUpdated` carries the whole turn). The reducer
is a set of upserts, replay is idempotent, and superseded snapshots can be
compacted keep-latest.

Provider-originated updates use compare-and-swap writes instead of locks: an
update from an attempt that lost ownership, or a late provider thread snapshot
from a superseded attempt, is rejected inside the transaction.

## Jobs

Job kinds are partitioned exhaustively into those that are safe to replay
after process loss and those that are not. Replayable jobs that were running
when the process died are requeued at startup; non-replayable ones are
cancelled with a reason.

Rows carry `status pending|waiting|running|succeeded|failed|cancelled`,
`attemptCount`, `availableAt`, and a lease. A failure chooses its retry:
automatic with backoff, on demand (the job is parked as `waiting` until a user
action or boot recovery drains it), or never. Job ids derive from the requesting command so
retries collapse on insert. Claiming is one atomic update. Jobs for one
session run in order; jobs for different sessions run in parallel. Workers
race execution against a per-job cancellation signal armed before the row is
re-read; retries back off from 100 ms to a 30 s cap. Notifications are a
latency hint; the row is authoritative and a liveness poll covers missed
notifications and other processes.

## Provider threads instead of provider processes

| Level | Lifetime | Persisted | Identity |
| --- | --- | --- | --- |
| `Session` | forever | events | app |
| `ProviderThread` | one native conversation; a session accumulates several | events, with `nativeThreadRef` | derived from native id |
| `ProviderSession` | one live process; released on idle, crash, shutdown | metadata only; never resurrected | app |

The provider session manager owns residency: open lazily under a per-session
lock, release on idle with background-work pinning, flip pending requests to
expired on release. It never restores processes at boot.

Each provider thread records which turn ordinals it saw natively and which
handoffs it received. Returning to a provider resumes its earlier thread and
injects a delta handoff for the turns it missed.

Transition policy, in order: target unavailable → reject; no current provider
session → create with handoff; provider or continuation key mismatch → create
with handoff; same provider with changed model → the driver's own plan;
runtime mode or workspace changed → restart and resume; otherwise reuse.

A failed native resume never silently starts a fresh transcript. It creates a
replacement provider thread, a `provider_resume_fallback` link, and a
full-session handoff, all recorded.

## Turn lifecycle

`message.dispatch` carries an intent: `defer_start`, `steer_active`,
`restart_active`, `queue_after_active`, or `start_immediately`. Policy turns
it plus capabilities into start, steer, restart, queue, or provider switch.

- Start: turn `starting`, attempt `initial`, root step, message, user
  timeline item, checkpoint scope, job `provider.turn.send`. The job captures
  the baseline checkpoint, opens or resumes the provider thread, and flips
  turn/attempt/step to `running` with a compare-and-swap.
- Queue: turn `queued` with a position; the user timeline item materialises
  only when the turn starts so it maps onto the provider turn. Promotion runs
  under the session lock after any terminal turn.
- Steer: native steer appends a message bound to the current attempt;
  otherwise a new `steering_restart` attempt supersedes the old one under the
  same turn.
- Interrupt: before a provider turn exists, terminalise locally and cancel the
  pending send job atomically. Otherwise emit an `interrupt_requested` item
  and the job; the turn stays active until the provider reports terminal.
- Finalising: provider `completed` persists the turn as `finalizing` and
  enqueues the replayable `checkpoint.capture`; only after capture is the turn
  `completed`.

Ingestion accepts only events the turn owns and keeps running after the root
terminal while child provider turns, subagents, or background steps are open,
but only for completed roots. Interrupted or failed roots cascade terminal
status to everything they own.

## Requests, forks, subagents, checkpoints

- One native approval yields a step, an `InputRequest` with live
  answerability, and a timeline item, all with derived ids. Answering commits
  `answered` then runs the `input.answer` job. Provider release or restart
  turns pending requests into `expired`.
- `session.fork` clones the session row with lineage and a pending fork link.
  The fork's first message resolves native fork or a portable handoff.
  Merge-back records base and source points and injects a delta handoff into
  the source's next turn.
- Provider-native subagents become a `subagent` step plus a child session with
  lineage. App-owned delegation creates a child session and turn with a
  `subagent_spawn` link; child terminal records `subagent_result` and offers
  the parent a bounded completion wake.
- Checkpoints are git refs per (scope, ordinal) with a baseline before each
  turn and a capture after. Rollback restores files, rolls back the provider
  conversation when the capability exists, marks later turns `rolled_back` and
  later checkpoints `stale`.

## Recovery

Startup: verify projection watermark against the log → rebuild if invalid →
reconcile → start the job worker → ready. Reconcile cancels every
non-terminal turn (except `finalizing` turns with a pending capture), expires
pending requests, cancels attempts, steps, provider turns, orphaned background
steps and their subagents, sets provider threads idle and provider sessions
stopped, then reconciles the job ledger and drains it. The same reconcile
runs as a shutdown finaliser.

Attempts carry leases renewed by the ingestion fibre. A sweeper terminalises
expired leases and reclaims their jobs, so a dead fibre in a live process or a
second server process cannot strand work.

Turns that were running at restart get a `provider_recovery` attempt: resume
the native thread, inspect it, and finalise from the transcript, re-issue the
message once, or cancel with a reason. Output produced while the server was
down is backfilled from native transcripts through the external-thread reader.

## Target liveness guarantees

These are acceptance criteria for the completed engine. They require fault
tests and bounded detection budgets; a schema or durable status alone does not
establish them. During a network partition a client can only show its last
confirmed state and that it is disconnected. A suspended host cannot execute
agents or run its watchdog until it wakes.

1. **A stuck agent cannot look healthy.** Every running attempt holds a lease
   renewed by the fibre that ingests its provider events. Liveness is derived
   from the lease, the provider process, and the last event time, never from a
   status column. An attempt whose lease expires, whose process exits, or whose
   provider stream ends is terminalised by the sweeper with a reason. An
   attempt that is alive but has produced nothing for longer than its
   inactivity budget is shown as `stalled` with the time of its last event and
   actions to interrupt or retry. Liveness carries an `authority`: `driver`
   when the provider speaks a structured protocol (SDK, JSON-RPC, ACP), and
   `heuristic` for plain terminal sessions where state is inferred from the
   screen. Heuristic states are labelled as such in the UI and never trigger
   automatic input.
2. **The UI identifies stale state and converges with the engine.** Clients render server-owned
   projections keyed by a global sequence. Running, blocked, stalled, and idle
   come from the graph: an active attempt, a pending `InputRequest` with live
   answerability, an expired lease, or nothing. There is no client-derived
   status. A reconnect resumes by delta when the gap is small and by snapshot
   otherwise, and duplicates are dropped by sequence, so a client is never
   ahead of or behind the log without knowing it.
3. **Nothing waits on an in-memory handle.** Every pending thing has a durable
   row with an expiry: jobs have leases and retry policy, input requests have
   answerability, attempts have leases. A restart or crash turns each of them
   into an explicit state with a reason instead of a spinner. The server runs
   detached from any window, so closing the app or dropping the network does
   not touch provider processes; the client reattaches like any other client.

"Blocked" is deliberately strict: a session is blocked only when a pending
`InputRequest` exists. Sending a message to a blocked session returns
`blocked` with the request instead of queueing input behind it.

## Semantic waits

Agents and clients coordinate on graph state, never on process completion.
`session.wait` takes a session, an optional turn or attempt id, and a target
state (`idle`, `blocked`, `done`) and resolves when the durable state reaches
it. The wait is pinned to the attempt it started against, so a restart or a
replacement attempt cannot satisfy it by accident. `session.send` accepts an
optional wait so a prompt and its wait are one atomic request. The
orchestration tools that let an agent delegate to other agents are built on
these primitives, so a parent never polls output text or fires keystrokes
into a child that is not ready.

## Streaming

The existing epoch and version cursor protocol in `realtime-runtime.md`
remains. Additions: snapshot and sequence are read in one transaction; a
reconnect replays by delta when the gap is under 128 events and 1 MiB and
otherwise sends a fresh snapshot; clients drop any event at or below their
last sequence; large snapshots and history pages go over HTTP; per-item wire
truncation at 32 KiB; sidebar deltas coalesce to the newest event per session
per window. A reconnect during a running turn resumes by delta; the client no
longer forces a full snapshot because it distrusts its cached turn.

## Delivery slices

Each slice fully replaces one working mechanism, migrates existing data,
keeps the app working end to end, and ships as its own pull request.

| Slice | Replaces | With |
| --- | --- | --- |
| 1 | Provider reactors over event cursors, the effect receipt journal, and the startup suppression set | Durable job ledger and worker enqueued in the command transaction; jobs reconciled at boot |
| 2 | `sessions.cursor`, `resume_strategy`, `provider_event_cursor` | `ProviderThread` rows with native refs (`session_provider_threads`); switching provider or worktree retires the active thread |
| 3 | The single `currentTurnId` and ad hoc provider retries | Turns with ordinals and attempts (`session_turns`); retries and boot recovery are new attempts that supersede the earlier send job; the timeline carries `activeTurn` and `turnCount` |
| 3b | Client-side turn state | Steps, timeline items with banded ordinals, and the finalising barrier follow with checkpoints |
| 4 | The permission side channel and quarantine | `InputRequest` steps in the timeline with answerability; questions and plan approvals unified |
| 5 | Bespoke driver start functions and the provider-service if/else | Capability-declaring driver contract, registry, and provider session manager |
| 6 | New tab per provider | Provider switching in place with context links and handoffs |
| 7 | Archive-scoped checkpoints as the unit of rollback | Turn checkpoints and rollback with provider reconcile |
| 8 | `parentItemId` flattening and `origin_session_id` lineage | Subagents as child sessions with steps and completion wakes; `session.wait` and atomic send-and-wait for the delegation tools |
| 9 | `recoverStaleSessions` | Total reconcile, attempt leases with a sweeper, `stalled` detection, `provider_recovery` attempts, transcript backfill with credential redaction |
| 10 | Server hosted in the window process | Detached local server the shell attaches to |
| 11 | Client-derived liveness and forced snapshots on reconnect | Server-owned timeline and liveness with a cross-session attention rollup (blocked, stalled, idle counts); delta resume mid-turn |

## Outcome groups and release gates

Implement larger groups that each deliver a complete user outcome. Finish the
replacement and its migration before adding another parallel state model.

### A. Correct execution and recovery

Complete and harden slices 1–3 together with the ownership and recovery parts
of slice 9. Carry the active attempt identity through jobs, provider events,
and transactional settlement. Deliver cancellation after commit, verify
ownership after registering cancellation, and reject superseded work at the
provider boundary. Scope command outcome waits to the requesting work; keep
the global drain for explicit maintenance only.

Establish exclusive runtime ownership before reconciliation, finish local
reconciliation before workers claim jobs, and expose readiness without
waiting indefinitely for provider interaction. Add renewable claims with
generation fencing and an expiry sweep. Distinguish runtime heartbeat,
provider activity, and client connection freshness.

A durable outbox ensures committed intent survives. It does not establish
exactly-once external execution. If the provider accepted a message before
the acknowledgement was persisted, recovery must inspect provider evidence
or use supported idempotency. Without either, show an explicit uncertain
outcome and require an intentional retry instead of silently resending.

Gate: inject failure before send, after provider acceptance, before local
acknowledgement, and during settlement. Test cancellation at every claim
boundary, late events after retry, stream failure without a terminal event,
expired owners, and two sessions where only one fails. Verify that forked
sessions seeded from the same native thread cannot modify or delete one
another's thread metadata.

### B. Durable interaction and truthful clients

Combine slices 4, the minimum driver capability work in 5, and 11. Deliver
one durable input-request lifecycle and one server liveness projection used
by desktop, mobile, sidebar, and timeline. Transport disconnection is distinct
from execution failure. Optimistic submission stays separate from confirmed
execution state. A quiet provider is not automatically a failed provider.

Gate: disconnect during an approval, restart before and after an answer,
submit the same answer twice, replay duplicate and reordered events, and
reconnect with a stale epoch. Requests must either be answerable against the
current runtime or visibly expired. Snapshot content and cursor must describe
the same committed state. Measure reconnect bytes and latency on large history.

### C. Agents outlive the desktop app

Deliver slice 10 and the remaining recovery/backfill work in 9. Reuse the
existing server composition and Serve CLI in a supervised process with one
owner per data directory. The desktop attaches as a client. Separate window
close, application quit, explicit engine shutdown, host sleep, and host loss.
Closing a laptop does not keep local CPU work running; uninterrupted execution
requires an awake host or a remote workspace.

Gate: quit and reopen the desktop during a tool call; detach every client;
kill the server; suspend and resume the host; attempt a second server start;
upgrade while work is active. Verify history, ownership, approval expiry,
recovery outcome, and redacted backfill. Run native lifecycle tests on each
supported desktop platform before claiming this outcome.

### D. Portable sessions and delegated work

Complete slices 5–8 and 3b: provider switching with recorded context coverage,
forks and merge-back, steps, subagents, semantic waits, and turn checkpoints.
Use the capability policy and fenced attempts from earlier groups.

Gate: switch A → B → A without missing or duplicating context; fork from an
earlier turn; complete a child while its parent is running; interrupt a parent
with live children; fail checkpoint capture; and roll back files plus provider
context. A failed handoff or checkpoint must remain explicit and recoverable.

## Testing

Replay-backed integration tests: real domain, drivers, persistence,
projections, and checkpoint policy; only the provider transport is a recorded
transcript. `TestClock` for time and a deterministic id source for ids. The
invariant set: simple, multi_turn, steering, interrupt,
steering_restart_fallback, subagent, subagent_checkpoint, rollback, approval,
provider_switch_return, restart, and lease sweep.
