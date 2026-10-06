# Agent Engine

The Agent Engine owns provider execution independently of desktop windows. The
session event log is authoritative; SQL projections serve clients and durable jobs
schedule provider work. [ADR 0005](../adr/0005-agent-engine.md) records the design
direction. This document describes the implemented runtime rather than proposed
entities or a history of implementation steps.

## Ownership and execution

A session contains counted turns, attempts, execution steps and provider threads.
A provider thread is durable native conversation identity. A provider session is
one live process residency; its identity is never reused after replacement.

| Responsibility | Implementation |
| --- | --- |
| Commands, receipts and transactional ownership guards | `packages/domain/src/engine/dispatch.ts` |
| Session decisions and replay | `packages/domain/src/core/` |
| Durable job claims, cancellation and retry | `packages/domain/src/agent-engine/` |
| Provider job execution and recovery | `apps/server/src/conversation/core/provider-jobs.ts` |
| Driver acquisition and live callback ownership | `apps/server/src/provider/` |
| Provider-specific protocols and process cleanup | `packages/agents/src/drivers/` and `kernel/` |
| Event ingestion and attempt leases | `apps/server/src/conversation/core/conversation-event-runtime.ts` |
| Client projections and subscriptions | `packages/client-runtime/` |

Command admission serializes work per session. A single transaction appends events,
applies projections, records the command receipt and enqueues jobs. Notifications
and cancellation happen after commit. Repeating a command ID returns its receipt;
it does not repeat the provider operation.

Jobs use renewable claims with distinct acquisition owners. Provider start, send,
interrupt and stop operations carry attempt and provider-session identity. Both
in-memory admission and transactional writes reject superseded ownership. Startup
and shutdown release only resources acquired by that operation. Uncorrelated
providers use a fresh handle for each attempt instead of assigning late events to
a later request.

The job ledger and delivery journal have different responsibilities. The ledger
tracks work to perform; the journal records whether a non-idempotent provider send
crossed its delivery boundary. A crash after acceptance cannot be resolved by
blindly retrying the job. Exact native execution evidence permits read-only
recovery and backfill; missing or incomplete evidence yields an explicit uncertain
outcome. Recovery never automatically resends uncertain input.

Provider-started turns acquire a durable attempt and their own ingestion lease.
If a provider turn races an application send, its events are adopted without
allowing its terminal event to finish the application turn prematurely. Late tool
output can append to the latest completed attempt only when the provider residency,
attempt and original tool anchor still match. New turns, replacement residencies
and retries revoke that authority.

## Inputs and liveness

`session_inputs` projects permission, question and plan lifecycle in the same
transaction as transcript events. Durable input state is distinct from the live
callback that can answer it. Callback IDs belong to an acquisition; replacement
cannot accept an old answer. Expired inputs remain visible and dismissible.
Questions and plans share callback delivery coordination but retain their native
acknowledgement protocols. Plan intent and acknowledgement are stored separately,
so restart can repair acknowledged receipts without repeating uncertain delivery.

An ingestion lease identifies the exact consumer, attempt and provider residency.
The consumer renews it; blocked ingestion therefore stops renewal. A bounded
sweeper rechecks ownership before recovery or terminal settlement. One blocked
session cannot stop recovery of other sessions.

Server observations distinguish startup, running, quiet, blocked and missing
execution ownership from client transport disconnection. Clients accept only
observations for their current epoch, version and attempt. Sidebar subscriptions
retain active sessions while the conversation view is unmounted, and release them
when live state settles. Quiet execution is not itself failure.

## Desktop lifetime

The Electron shell attaches to the standalone engine through an authenticated
local transport. A supervisor owns worker restart; a process-lifetime database
lock prevents concurrent engines using the same profile. Reattachment checks
engine executable identity, native ABI and release version.

Desktop quit detaches clients without stopping provider work. Pending RPC calls
fail on disconnect without replaying mutations. Native actions belong to an exact
attachment; cancellation or attachment loss revokes their response authority.
Discovery and sleep prevention belong to the engine, with helper lifetime tied to
its owner process. A sleeping host cannot continue local execution.

Updates and listener changes share one maintenance coordinator. It checks durable
turns, jobs, file restores, forks and delegations before closing admission. Active
work refuses replacement; idle shutdown waits for both worker and supervisor exit.
Account notifications use a bounded background queue. Account HTTP requests,
provider startup and process teardown have bounded lifetimes; human approval waits
and ordinary long-running turns do not inherit those startup deadlines.

## Context, checkpoints and delegation

Idle sessions can switch providers in place. A switch freezes a redacted text
handoff transactionally and retires the previous live residency. Returning to a
supported native thread adds only missed context. Unavailable native history uses
a recorded full-context replacement. Handoffs are bounded text; prior attachment
payloads remain in the application transcript rather than being replayed wholesale.

Counted turns capture Git baselines before execution and remain finalizing until
final capture succeeds. Failed capture is visible and retryable. Restore previews
changes, fences execution and journals file restoration before truncating context.
Verified native checkpoint boundaries can preserve provider history; otherwise
restoration uses retained transcript context in a replacement thread. Nested
native tasks do not offer independent rollback without a filesystem write barrier.

Execution steps represent native children and explicit background shell tasks.
They can keep a root active after its response finishes. App-owned delegation binds
a child session to its parent attempt, persists results and schedules a stable
completion wake. Verified completed Codex children can be copied into canonical
sessions; unverified lineage or incomplete child history is unsupported.

Semantic waits pin a turn and attempt with an event cursor. They report replacement,
deletion, timeout and terminal-before-target explicitly. Canceling an observer does
not cancel admitted execution. Intentional queueing remains separate from a normal
composer send blocked by a pending input.

## Retired paths and retained compatibility

Provider cursor reactors were replaced by durable jobs. Cursor reactors remain
for naming, archive and delete work, which consume committed events rather than
send provider prompts. The old desktop in-process RPC protocol is replaced by the
engine bridge; there is no second desktop execution host.

Persisted event schemas, migrations, imported-session fields and delivery receipts
are compatibility requirements, not alternate runtime implementations. Existing
profiles and earlier branch databases must upgrade without discarding history.
Do not remove these because current writers no longer produce an old event.
Read [runtime data recovery](../cloud/runtime-data-recovery.md) before changing
storage paths or recovery of existing sandbox data.

Archive snapshots and turn checkpoints serve different operations: restoring an
archived worktree and rolling back a conversation turn. Mobile still consumes
attempt-history and checkpoint RPCs even when desktop header controls are absent.
Only contracts used by the actual projections and RPCs belong in the codebase;
unimplemented graph schemas and identifier allocators are not runtime foundations.

## Verification and limits

Run applicable package types, Biome and behavior suites for the changed paths.
Important regression boundaries are superseded attempts, canceled startup,
late callbacks, failed sends, interrupted recovery, provider switching, checkpoint
restore, client reconnect and desktop detach.

- `bun run --cwd apps/desktop test:engine` exercises ownership and crash recovery.
- `bun run --cwd apps/desktop test:engine-provider` also uses the installed Codex
  executable and real shell tools against scripted local inference.
- `bun run --filter desktop test:engine-reliability` adds an unresponsive linked
  account endpoint. See [failure verification](agent-engine-reliability.md).
- `bun run test:live-agents` exercises configured authenticated providers;
  disabled providers are skipped.

Fixtures use temporary profiles. Scripted inference tests exercise the real driver,
engine, supervisor, database and tool processes, but do not establish every external
provider's behavior. Strong native execution correlation is currently
provider-dependent; unknown outcomes stay explicit. Windows process-tree cleanup
and each deployed cloud runtime still require their own end-to-end verification.
