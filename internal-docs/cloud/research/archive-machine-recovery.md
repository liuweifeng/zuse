# Agent state after deleting an archived machine

Research date: 2026-10-12. Scope: agent/session recovery; this note does not claim that the cloud lifecycle already implements off-machine backup or restore.

## Finding

Yes: machine lifetime can be separated from conversation lifetime. Zuse already has useful durable engine state and portable conversation handoffs. Those mechanisms do not themselves make deleting the machine safe: their backing data must first survive outside that machine. A new machine can continue a preserved conversation, but an exact native Claude/Codex continuation additionally needs the provider's session artifacts. Neither a chat transcript nor an engine checkpoint recreates the complete filesystem or running processes.

## What exists today

| Mechanism | What it preserves | What it does not establish |
| --- | --- | --- |
| Zuse harness journal | Versioned agent graph, model history, mailboxes, compaction checkpoints, tool intents and results, with revision-based writer ownership. | Off-machine durability. The host journal is a `harness_executions` SQLite row. |
| Portable provider handoff | A bounded representation of prior conversation, usable with a fresh provider session. | Exact native continuation or the full history in the next model prompt: capture takes at most 200 messages; rendering caps at 60,000 characters. |
| Native history checkpoint | Provider ID, native thread ID and ordered turn IDs. Codex verifies the existing thread and can roll it back to that boundary. | A portable export. It contains neither native message payloads nor provider session files. |
| Session rollback | Coordinates file checkpoints, transcript rollback, provider detachment and native verification or portable fallback. | A backup outside the sandbox or generic machine migration. |

Sources: [harness state](../../../packages/agents/src/harness/state.ts), [journal storage](../../../apps/server/src/harness/journal.ts), [portable handoff](../../../apps/server/src/conversation/core/context-handoff.ts), [native checkpoint contract](../../../packages/contracts/src/session-checkpoint.ts), [Codex checkpoint implementation](../../../packages/agents/src/drivers/codex-history-checkpoint.ts), [rollback orchestration](../../../apps/server/src/conversation/core/checkpoint-restore.ts).

Engine recovery deliberately changes formerly running agents to interrupted. A tool receipt with an uncertain outcome pauses recovery instead of blindly repeating the side effect. This is a sound foundation for migration, but not a promise that every interrupted action automatically resumes. [Engine initialization and tool receipts](../../../packages/agents/src/harness/engine.ts).

## Provider-native portability

Claude documents cross-host resume using saved JSONL session files or a `SessionStore` adapter. The working-directory lookup and CLI version matter; preserve a stable workspace path. Conversation persistence does not preserve filesystem changes. Zuse's Claude driver currently supplies resume/fork options; this review found no Claude `sessionStore` integration in the driver. [Official Claude sessions documentation](https://code.claude.com/docs/en/agent-sdk/sessions), [Zuse resume options](../../../packages/agents/src/drivers/claude-fork-point.ts), [driver](../../../packages/agents/src/drivers/claude.ts).

Claude's external store is a mirror, with best-effort writes: failed batches can be dropped after retries, while the query continues. It therefore cannot be treated as a deletion acknowledgement without explicit completeness verification. Its file-checkpoint backups are not mirrored. For subagents, the store interface also has subkey support. [Official session storage documentation](https://code.claude.com/docs/en/agent-sdk/session-storage).

Codex `thread/resume` reopens stored native threads. Its documentation identifies persisted rollout files and associated metadata; Zuse's checkpoint capture stores identifiers, not those files. The current driver starts a replacement thread when a native rollout is missing. Recommendation: preserve and restore the required native session artifacts for exact continuation, with portable context as an explicit fallback. This research did not validate cross-host Codex artifact restoration end to end. [Official Codex app-server documentation](https://developers.openai.com/codex/app-server), [Zuse Codex driver](../../../packages/agents/src/drivers/codex.ts), [checkpoint capture](../../../packages/agents/src/drivers/codex-history-checkpoint.ts).

## Recommended archive contract

This is a proposed design, not implemented behavior:

**Current retention is destructive logical deletion, not compute retirement.** Archive expiry sets `desiredState: deleted`; the deletion path removes the provider sandbox, transcript objects and checkpoint rows, clears the wrapped transcript encryption key, and marks the workspace deleted. Transcript reads reject deleted workspaces. Changing only the timer to ten days would not meet the requested history guarantee. Introduce a separate archived-without-compute lifecycle that retains the logical workspace, transcript catalog and key. Explicit user deletion should remain a separate operation. [Reconciler](../../../infra/api/src/cloud-workspace-reconciler.ts), [transcript read route](../../../infra/api/src/cloud-workspace-routes.ts).

The existing transcript publisher uploads the recent head before older history pages, with accepted/history versions held in runtime memory. A published head alone therefore is not a durable completeness barrier for deleting the last disk. The archive needs a verified manifest covering every session and its required attachments/artifacts. The existing Boxd fork path also requires the original workspace to be ready; it is not a restore from an independently stored archive. [Transcript publisher](../../../apps/server/src/api/cloud-workspace-runtime.ts), [machine fork](../../../infra/api/src/cloud-workspace-fork.ts).

Operational limitation: the earlier cleanup of 21 archived machines used the existing destructive lifecycle, according to this investigation's operator record. Their complete histories cannot be promised recoverable without checking independent surviving copies; this research did not establish such copies.

1. Preserve full Zuse conversation data independently of compute, including attachments and referenced artifacts. A cached preview or bounded provider handoff is not a complete backup.
2. At an idle archive boundary, fence writes and create a consistent runtime backup. Include engine journals, relevant domain records, native provider session artifacts, repository/worktree changes, untracked user files, and required local Git checkpoint objects. Define explicit exclusions rather than claiming an arbitrary machine filesystem is completely reproduced.
3. Store an immutable backup manifest with workspace identity, schema/runtime version, file inventory and integrity checks. A successful verified backup is a prerequisite for deletion after the retention period. If backup fails, keep the machine and retry.
4. On reopen, provision compatible compute, restore before starting the runtime, preserve chat/session identities and paths, then verify native continuation or explicitly use the existing portable handoff. Do not retry uncertain side-effecting tools automatically.
5. Re-authorize runtime and provider credentials through current credential mechanisms. Do not put OAuth refresh tokens, runtime identities, or old machine grants into a reusable image or blindly clone entire provider configuration directories. Archive session data separately from credential files; issue fresh machine-scoped authority.

SQLite backup must include committed WAL state (backup API or a verified stopped-writer copy), and only one runtime may own restored state. These are existing repository recovery requirements. A backup containing only message rows, or only a live `.sqlite` file while losing its WAL, is insufficient. [Runtime data recovery rules](../runtime-data-recovery.md).

For full arbitrary filesystem fidelity, provider disk snapshots may be another implementation, but their survival after machine deletion, exportability, cost and credential handling need provider-specific verification. In-memory processes cannot survive actual machine deletion through transcript restoration; Boxd sleep remains the faster option for recent workspaces. No latency promise follows from this research.

## Acceptance evidence before enabling shorter deletion

Use a populated archived workspace containing original chat/session IDs, a long transcript, attachments, native Claude/Codex state, modified and untracked files, and a harness checkpoint. Verify the independent archive, delete the old test machine, restore onto a different machine, read the original history, and complete one new turn without duplicate execution. Also prove failed/incomplete backup blocks deletion and restoration uses fresh credentials. This note made no production changes and performed no destructive restoration experiment.
