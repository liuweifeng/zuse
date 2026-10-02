# ADR 0005: Agent Engine

- Status: Accepted
- Date: 2026-09-02
- Related: `internal-docs/architecture/agent-engine.md`,
  `internal-docs/architecture/realtime-runtime.md`

## Context

A Zuse session is an event-sourced aggregate whose identity is fused to one
provider process: a single `currentTurnId`, a resume cursor column, and a
provider id that cannot change once the first message is sent. Provider side
effects run from live reactor subscriptions over event cursors, and liveness is
a `status` column that can lag settlement in both directions. This shape
produces a bug class that patching does not remove: stuck "running"
indicators after a crash, approvals that answer into a dead callback,
`SessionNotFound` errors when a provider handle is gone, lossy forks, subagents
flattened into the parent transcript, and no way to switch provider inside a
conversation.

The Agent Engine is the server subsystem that owns agent sessions as a durable
graph and treats every provider as a replaceable backend. Orchestration in
Zuse means an agent delegating to other agents; that feature is built on top
of the engine and is not the engine.

## Decision

1. **A session owns a durable graph, not a transcript.** `Turn` (counted user
   turn) → `Attempt` (one provider execution) → `Step` tree. Only the root
   step of the active attempt may complete a turn. A child finishing never
   closes its parent.
2. **Provider identity is a reference on a `ProviderThread`, not a session
   column.** A session accumulates provider threads over time, each with a
   covered turn range and handoff ids. Provider switching happens in place
   inside one session; the "new tab per provider" behaviour is retired.
3. **App ids are identity; provider ids are evidence.** Entities carry
   `ProviderRef {provider, nativeId, strength}`. Ids that can be observed more
   than once are derived, content-addressed values (`@zuse/domain/agent-engine/ids`),
   so re-observation is an upsert.
4. **Every provider interaction is a durable job.** Commands commit events,
   projections, receipts, and job rows in one SQLite transaction. A job worker
   claims jobs with leases, retries with backoff, and cancels on request. Jobs
   are classified as replayable after process loss or not. Reactors remain
   only for derived work such as naming and archiving.
5. **All provider branching is capability policy.** Drivers declare
   `ProviderCapabilities` when a provider session opens; the engine branches on
   those flags in one policy module and never on `ProviderId`.
6. **Approvals and questions are `InputRequest`s with explicit
   answerability.** A request survives restart; its answerability does not.
   Expired requests are rendered as expired, never as answerable.
7. **Recovery is total and runs before readiness.** Startup and shutdown
   reconcile every non-terminal turn, attempt, step, request, and provider
   session, then reconcile the job ledger, then drain it. Attempts carry
   leases renewed by their ingestion fibre; a sweeper terminalises expired
   leases so a dead fibre or a second server process cannot strand work.
8. **Agents outlive the window.** The desktop shell attaches to a detached
   local server so closing the window does not kill provider processes. After
   a restart the engine resumes native provider threads with a
   `provider_recovery` attempt and backfills output produced while the server
   was down from native transcripts.
9. **The client renders liveness only from server-owned fields.** Running,
   waiting, background-remaining, retrying, and expired states come from the
   graph, never from a cached status.

## Delivery

The engine replaces the existing runtime one working piece at a time. Each
slice fully replaces one mechanism, migrates existing data, keeps the app
working end to end, and ships as its own pull request. Slices are listed in
the architecture document.

## Consequences

- The `Session` aggregate is evolved in place. Existing history is imported as
  turns tagged as imported; the first continuation on an imported session
  receives a transcript handoff.
- The two-stream client join (timeline plus permission requests) collapses
  into one projection.
- Turn-level git checkpoints replace archive-scoped checkpoints as the unit of
  rollback.
- `chat_creation_operations` is retired in favour of a turn in `preparing`.

## Required verification

- Replay-backed integration tests with recorded provider transcripts at the
  transport boundary only; no mocked engine, driver, policy, or reducer.
- Restart tests: no non-terminal row survives reconcile; replayable jobs
  complete; non-replayable jobs are cancelled with a reason; queued turns
  resume.
- Duplicate command dispatch returns the original receipt without re-running
  any provider job.
