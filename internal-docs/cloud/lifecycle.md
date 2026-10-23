# Cloud lifecycle

API owns cloud lifecycle as a revisioned desired-state machine. Routes record
intent; a leased reconciler performs provider operations and commits observed
state with compare-and-set protection. Retrying a request cannot create a
second workspace transition.

## Account image, project, and workspace are different resources

An account has one active private image generation containing the runtime,
toolchains, selected repository checkouts, and configured agent authentication.
A cloud project is repository metadata selecting one checkout from that image.
A cloud workspace is one isolated E2B sandbox created for a chat or task from
the active account image.

An explicit image update/rebuild happens outside workspace launch. A repository
absent from the active image cannot use a slow launch-time clone fallback. An
existing workspace remains on its original image generation and sandbox ID;
image promotion changes only future workspaces.

## State vocabulary

The durable observed workspace states are:

| State | Meaning |
| --- | --- |
| `queued` | Accepted and waiting for reconciliation |
| `provisioning` | Allocating provider compute |
| `setup` | Bootstrapping identity, repository, and runtime |
| `ready` | Workspace exists and can be online or paused |
| `pausing` | Quiescing and asking the provider to pause |
| `paused` | Provider compute is stopped; workspace storage is retained |
| `resuming` | Resuming the same provider sandbox and runtime generation flow |
| `archiving` | Settling work, checkpointing, and pausing for trash retention |
| `archived` | Hidden from active chats and retained for the archive window |
| `deleting` | Permanently removing provider and transcript resources |
| `deleted` | Content is gone; only a temporary tombstone remains |
| `failed` | Reconciliation reached an actionable failure state |

Desired states are smaller: `ready`, `paused`, `archived`, and `deleted`.
Observed state may pass through intermediate states while converging on the
desired state.

Startup exposes stable phases for user feedback: allocating, booting,
authenticating the runtime, syncing the repository, starting the agent, and
running. Runtime connectivity is separately offline, connecting, or online. A
running agent does not change a healthy cloud icon from online to reconnecting.

## Create and start

1. API authenticates the WorkOS account and checks the Cloud entitlement.
2. The client sends a stable workspace and command identity.
3. API records the workspace request and encrypted launch intent atomically.
4. The reconciler creates or restores a sandbox from the compatible account image.
5. The runtime starts with a one-time token and registers its signing and
   encryption keys.
6. After validating retained storage and establishing the initial chat/session,
   the runtime opens its authenticated gateway. The client opens the chat and can
   submit durable prompts while preparation runs.
7. Account credentials and repository/branch preparation report actual progress.
   The shared execution gate releases agent startup and queued sends only after
   both prerequisites complete. Ordinary startup uses the installed runtime;
   release downloads are explicit maintenance.
8. The runtime records command receipts in SQLite and reports monotonic summaries
   to API.

Agent execution begins only after worktree setup is complete. A client closing
after acceptance does not interrupt the runtime consumer.

## View, connect, and wake

Viewing a cloud chat does not imply compute:

- `cache-only` reads local persistence.
- `sync` reads catalog metadata and a newer R2 checkpoint without waking compute.
- `connect` attaches only when the runtime is already online.
- `wake` resumes or creates compute, then attaches.

Opening a paused or archived transcript uses cache/R2. Sending a message,
cancelling, changing a queue, or opening an interactive file/Git/review/terminal
resource requests `wake`. Resume is single-flight for all surfaces.

## Pause and resume

Pause quiesces new work, attempts a bounded final transcript checkpoint, records
provider usage, and pauses the same provider sandbox. Checkpoint upload failure does
not destroy the authoritative SQLite database or block pause; the cloud copy is
marked stale and retried when the runtime next runs.

Resume reuses the same sandbox ID. A preserved runtime retains execution ownership
and renews access with its registered signing identity when needed. A broken socket
does not authorize a process restart. Confirmed process loss or explicit release
activation uses the guarded launch path on the original storage, with a fresh
execution fence when ownership transfers. The client keeps cached data visible
throughout. See the [runtime architecture plan](runtime-architecture-plan.md).

Account-image and runtime releases follow
[ADR 0002](../adr/0002-cloud-runtime-compatibility.md). A generation mismatch,
runtime timeout, or stale gateway socket never replaces a retained sandbox.

## Archive preserves history independently of compute

Archive pauses the same sandbox and records a ten-day compute retention deadline.
Unarchive clears that deadline and returns the chat to Active without starting
compute; the first interactive action resumes it. Re-archiving starts a new window.

Expiry no longer means permanent workspace deletion. Without a verified recovery
archive, keep the original machine. The recovery implementation is gated by
`CLOUD_WORKSPACE_RECOVERY_ENABLED` (off by default). Eligible managed workspaces
can be backed up, verified and retired; reopening restores their original state
on new compute before runtime enrollment. Custom snapshots and legacy native-auth
workspaces currently retain their machine. See [archive recovery](workspace-archive-recovery.md)
for captured roots, credentials, failure handling and rollout acceptance.

Explicit Delete remains permanent: it removes the machine, all workspace object
storage (including recovery archives), checkpoint and launch metadata, and runtime
secrets. A content-free tombstone remains for thirty days. Archived transcript
projections remain readable independently of compute; full database restoration
is separate from the existing transcript projection service.

## Reconciliation and failure rules

- Every lifecycle write carries an expected revision and lease owner.
- Older runtime generations and summary revisions cannot overwrite newer ones.
- Create, resume, archive, unarchive, and delete commands are idempotent.
- Provider timeouts retry with capped backoff and jitter under one reconciler.
- Webhooks and provider polling can report the same execution; immutable
  finalization keys ensure it is billed once.
- A failed archive or checkpoint never deletes the last authoritative sandbox.
- Losing the Cloud entitlement blocks new billable hosted operations, while an
  already accepted runtime turn may settle through internal callbacks.
