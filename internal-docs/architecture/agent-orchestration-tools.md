# Agent orchestration tools

The provider-neutral tool surface binds to the current durable session. Desktop
and cloud runtimes use the same conversation services, queue and projections.
MCP and the agent CLI call the same handlers and permission broker. Neither a
different transport nor a child provider grants additional permissions.

## Discovery and context

`orchestrator_capabilities` reports the current session, permission posture,
resolved provider/model catalog and read limits. Catalog reads include registered
ACP providers and user-added model IDs. Inventory freshness is not proof that a
provider is authenticated or that an account can run every model.

Shared workspace instructions explain delegation, explicit context, isolation,
retry identities and asynchronous completion. Providers retain their existing
instruction channel. Native subagents remain useful where the provider supports
the desired model and tools. A native subagent is not automatically an independent
Zuse session.

## Managed tasks

`delegate_task` creates a child session in the parent's chat and checkout. Pass an
explicit task and optional role; parent history is not copied implicitly. A stable
`clientRequestId` maps retries to the same child. The child inherits the parent's
current permission and runtime modes. Use `create_thread` for a separate worktree
when concurrent edits need isolation.

`task_status` reports the assigned task's state, pending children and captured
result. Reading status does not consume the completion notification; the durable
parent wake remains responsible for continuation. `task_cancel` cancels
descendants, pauses their queues, disables their
schedules and requests interruption through durable engine commands. Cancellation
does not undo filesystem edits. Human operators can later resume a session;
repeating cancellation must stop that new execution too.

Delegation completion uses the existing durable result and parent-wake machinery.
Agents should continue independent work or end their response instead of polling
in a loop. A parent's response ending does not prove nested work is finished.

## Sending and reading

`send_to_thread` accepts `auto`, `queue`, `steer` and `restart`:

- `auto` sends immediately when possible and otherwise uses the durable queue.
- `queue` explicitly queues the message.
- `steer` and `restart` request interruption and prioritize a durable successor.
  They do not promise provider-native steering of an already-running turn.

Reuse `commandId` after an uncertain response. Combined send-and-wait applies to
direct submission; queued work uses a separate `wait_for_thread`. A wait timeout
does not stop execution. `interrupt_thread` stops the current execution without
creating a successor.

`read_thread` uses bounded SQL reads. Omit the cursor for recent messages, or pass
an empty `afterMessageId` to begin at the oldest message. Continue using
`nextMessageId` while `hasMore` is true. A truncated item has `nextTextOffset`;
read that `messageId` and offset before advancing. `view: messages` filters
conversation text; `view: activity` includes tools and other message kinds.
Streaming text can change: explicitly reread its message ID to refresh it.
Deleted or foreign cursors fail rather than silently skipping data.

## Schedules and private requests

Schedules support a Unix timestamp, an interval of at least one minute, or an
authenticated webhook event. They target the current session's durable queue and
use its current permissions. Timer delivery and its receipt commit with queue
admission. Stable webhook event IDs deduplicate retries. Missed intervals coalesce
on resume; they do not create a backlog for every missed tick.

Scheduling does not wake or provision a sleeping cloud machine. The runtime must
be running to deliver work. Disabling or deleting a schedule prevents undelivered
events; already admitted queue items remain visible and can be managed with the
normal queue controls. Deleted schedule identities cannot be reused to resurrect
work accidentally.

`request_secret` creates a private password input. Metadata is stored in SQLite;
values use the existing credential backend and are never returned by request or
list tools. A supplied value binds to one environment variable in the requesting
session when its provider next starts. The UI explicitly requires a provider
restart. Providers and their subprocesses can use that environment value, so
agents must not print it. No plaintext secret getter is exposed by MCP or RPC.

## CLI and cloud

Run `zuse commands` for the current command manifest. `task delegate/status/cancel`,
`schedule create/list/update/delete/trigger`, and `orchestration list/call` use the
current provider session's authenticated gateway. They cannot impersonate another
parent by passing a remote target flag. Run those commands inside the intended
runtime/session.

Existing chat/session/model commands retain their `--cloud-workspace` support,
along with cloud provisioning, lifecycle, previews, plugins, forks and queue
controls. Human credential submission uses `secret provide --value-file -` so the
value is read from stdin rather than a command-line argument; results contain
metadata only. `secret list` and `secret dismiss` use the normal selected RPC
connection, including cloud targets.

Migration 0086 adds scheduler and secret-request metadata tables. It does not move
runtime data or replace an existing workspace database. Older runtime processes
must load the updated bundle before they expose the new RPCs and tools.
