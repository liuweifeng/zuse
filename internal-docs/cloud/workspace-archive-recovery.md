# Archived workspace recovery

Implementation status: implemented, with successful scoped Boxd staging recovery
on 2026-10-12 and Boat/E2B recovery on 2026-10-15. Deployment flag defaults off. Do not broadly enable
`CLOUD_WORKSPACE_RECOVERY_ENABLED` until the populated staging acceptance below
passes on each enabled provider. This is not a production rollout record.

## Lifetime and ownership

Archiving pauses the same sandbox for ten days. Reopening during this window
keeps the existing fast resume path, including Boxd process continuity. Expiry
never requests logical workspace deletion. The workspace record, chat/session
identities, transcript checkpoints, encryption key and launch metadata remain.
Only explicit Delete runs the existing destructive purge and thirty-day tombstone.

With recovery enabled, eligible expired workspaces enter this sequence:

1. Persist an archive operation and a new runtime generation. Revoke the old
   runtime bearer. Resume the sandbox and use the existing fenced process
   replacement to stop its runtime and agent process tree.
2. Acquire the shared runtime storage lock. Resolve existing data through the
   normal data-path resolver; do not initialize a replacement database.
3. Capture the data directory, `/home/repos`, Claude project/file-history state,
   and Codex session/rollout state and native state databases. Keep SQLite WAL
   sidecars. Check source metadata for changes during capture and validate an
   extracted copy with SQLite integrity and the expected original chat/session IDs.
4. Encrypt compressed archive chunks independently with AES-256-GCM, binding
   workspace, operation and chunk order in AAD. Upload immutable content-addressed
   objects to the existing private transcript object store. Upload the manifest
   last. A one-hour capability grants only this operation's upload or download;
   it grants no runtime, GitHub or provider credential access.
5. Reconciliation reads back every uploaded chunk and checks its digest in
   bounded batches. Only the completed verification advances to `retiring`.
   Persist that barrier before deleting the exact source machine. Keep all
   history objects and the verified recovery archive.
6. Unarchive returns the chat to Active without allocating compute. An interactive
   resume chooses the current compatible managed account image, provisions new
   compute, downloads and authenticates every chunk, checks SQLite and identities,
   then installs into staged directories. Preserve original image directories for
   interrupted-install recovery; never overwrite an authoritative database.
   Repository entries are installed inside the existing workspace-owned root,
   with a journal and preserved image entries under `.zuse-archive`. This does
   not require write access to `/home` or guest sudo privileges.
7. The helper records a completed restore only after installation and validation.
   The usual runtime restart then enrolls with a fresh generation and identity.
   No fresh-chat bootstrap or repository reset runs over the recovered state.

Unarchive before the retirement barrier cancels backup and restarts the retained
runtime. Once the barrier commits, reconciliation completes retirement before
processing a resume. The last verified archive remains available through restore
failure or a lost provider response. Explicit workspace deletion purges it with
other workspace objects.

## Scope and failure behavior

Initial eligibility is deliberately limited to managed layouts with both provider
and Codex credential brokering and a provider with fenced process replacement.
Custom snapshots and legacy native-auth workspaces remain paused after ten days;
they are **not automatically deleted**. No OAuth refresh token or native login
file is exported from the provider configuration directories. Runtime identity,
runtime bearer and GitHub broker files are excluded from the data directory.
Fresh provider credentials come from the existing authority/broker flow.

This preserves Zuse state and the listed roots, not arbitrary OS installations,
external mounts, or RAM. External symlinks and unsupported filesystem entries
fail backup instead of silently disappearing. Claude/Codex session artifacts are
included; exact native continuation still requires compatible SDK/tool versions.
Other agent-native filesystem layouts are not yet covered by the archive helper.
Engine journals are preserved in SQLite; uncertain tool outcomes retain the
engine's existing interrupted/recovery behavior, not automatic replay.

Archive failure retains the original machine. A completed backup does not follow
from a recent transcript head. Archived preview/page reads keep their existing
cloud transcript path; the archive is the authoritative full database recovery
copy, not a new offline transcript query service. The archive helper does not
backfill missing cloud transcript pages. Full recovered history is available
once restoration reconnects the runtime.

The helper needs Node with `node:sqlite`, Python 3, sufficient temporary disk, and
outbound access to the API. Chunks are 4 MiB before encryption/base64; the manifest
caps an archive at 8,192 chunks. Backup failure pauses compute; restore failure
retains both the archive and the partial target and surfaces a failed state.
An explicit restore retry renews its capability and generation. Re-archiving
creates a new operation; previous recovery objects remain until explicit deletion.
Storage retention/garbage collection across multiple archive generations is a
follow-up before broad rollout.

## Deployment and acceptance

Ship the API with the flag off first. The due-workspace query also picks up old
archived records ten days after their archive request, even if their recorded
alarm was thirty days out. No deadline backfill runs against an older API (which
treats expiry as logical deletion). Legacy records without an archive-request
timestamp keep their recorded deadline. An optional
`CLOUD_WORKSPACE_RECOVERY_WORKSPACE_IDS` comma-separated allowlist restricts
enabled recovery to disposable staging workspaces during acceptance.

Before enabling on a provider, use a disposable staging workspace containing a
long transcript, attachments, an engine journal, native agent sessions, Git refs,
uncommitted and untracked files. Verify its backup, delete its original machine,
restore to a different provider machine ID, inspect the same chat/session IDs and
all messages, and complete a new agent turn. Verify fresh authentication and no
repeat of uncertain tool side effects. Also test an interrupted upload, corrupted
object, failed restore and resume during backup. Record provider usage attribution
for the backup wake and the replacement machine.

Local evidence is in `infra/api/test/unit/cloud-workspace-archive.test.ts`, the
archive cases in `cloud-workspace-reconciler.test.ts`, and
`infra/cloud-sandboxes/test/workspace-archive.test.mjs`. The filesystem round trip
uses 350 messages, a WAL database, engine state, an attachment, untracked work and
native session files; it checks credential exclusions, retry and refusal to
replace an existing database. These tests do not substitute for a live agent
continuation and billing verification.

## Staging evidence — 2026-10-12

Only disposable workspace `workspace_buQ9Iw--J9wiTlq0` was allowlisted. Its
archive deadline was shortened for acceptance; other workspaces were excluded.
The source Boxd machine `f4e5f843-403a-4b22-82d6-899ada4d2df2` was deleted only
after all 26 encrypted chunks of the 108,241,949-byte compressed archive passed
read-back verification. Recovery used a different machine,
`1a2266c4-8580-4045-88a2-aeb890a0d50f`.

The original chat, session, SQLite data and Codex native thread survived. A new
turn on that native thread remembered the phrase from the baseline conversation
and read an untracked repository file, replying:

```text
ARCHIVE_RESTORE_OK archive glacier
ARCHIVE_UNTRACKED_SURVIVES
```

A separately seeded attachment file also survived byte-for-byte. This file was
not registered through the attachment UI; UI attachment acceptance remains open.
The original approval policy survived too: the read waited for permission, then
completed after a single scoped approval through the normal gateway RPC.

The first restore exposed a real image permission constraint: `/home` is
root-owned and the runtime cannot use sudo. Recovery failed without starting an
empty runtime. The final implementation installs repository entries inside
`/home/repos`; a retry recovered the same partial target and original database.
The final retry reached agent-running in roughly 26 seconds with an already
verified local archive. This is **not** a cold-download recovery benchmark. The
initial attempts and approval wait are not representative startup measurements.

Local tests cover 350 messages, WAL state, engine journal data, native session
files, encrypted multi-chunk transport, credential exclusions, database overwrite
refusal, idempotent retry and a protected repository-parent directory. The API
archive/reconciler suites passed 116 tests. API and client-runtime type checks
passed. Broad PostgreSQL integration tests were not run (no local test database);
the scoped live lifecycle exercised staging PostgreSQL and object storage.

Production has not been deployed. Staging's temporary allowlist enablement is
removed after acceptance. Daytona live recovery, usage settlement validation,
live interrupted-upload acceptance and archive-generation garbage collection remain
rollout prerequisites. Custom snapshots and unsupported native-agent layouts
retain their machines safely.

## Staging evidence — 2026-10-15

The test rollout allowed only the following two disposable workspaces. Their
archive deadlines were advanced to exercise ten-day expiry without waiting ten
days. Source deletion ran through normal reconciliation after object verification;
neither source was manually deleted to bypass that barrier.

| Provider | Workspace | Deleted source | Restored machine | Verified chunks | Request to agent-running |
| --- | --- | --- | --- | --- | --- |
| Boat | `workspace_lJ9dCDHh2wSTrONZ` | `bx_gmywm9bu` | `bx_qmpacyab` | 27/27 | 53.620 seconds |
| E2B | `workspace_jOfBKnbxoEBxjkuC` | `i1mjn1bi5mt5jmypjnmdp` | `i7f1z3g0xll9temwxrx18` | 27/27 | 29.464 seconds |

Both providers confirmed that the source no longer existed. Read-only inspection
of each restored database passed SQLite integrity checking and matched the
original chat ID, session ID, and active native Codex thread ID. Native rollout
files survived. The seeded attachment file and untracked repository file matched
their original SHA-256 hashes. After one normal scoped approval to read the test
file, both agents continued the original conversation and returned:

```text
ARCHIVE_RESTORE_OK
archive glacier
ARCHIVE_UNTRACKED_SURVIVES
```

E2B additionally used a real attachment uploaded through the public API and sent
with a message before archiving. While the source machine was absent, the history
API retained all previously observed message IDs and attachment metadata. The
materialized attachment on the replacement contained the exact original bytes
(`ARCHIVE_REGISTERED_ATTACHMENT_SURVIVES`). This verifies API attachment recovery;
an Electron UI rendering test was not performed.

The reported durations include replacement allocation, archive download and
installation, runtime authentication and resumed message delivery. They exclude
the subsequent manual tool approval and are not ordinary paused-machine wake
benchmarks. The current timing fields aggregate allocation and archive transfer;
they do not provide a trustworthy independent download/extraction breakdown.
E2B's initial baseline startup required a runtime retry after a bootstrap rejection.
The later archive restore succeeded without that retry; fresh-start reliability
is a separate unresolved finding.

The live runs exposed and fixed two additional recovery defects:

- Boat's `/home/repos` points to `/srv/zuse/repos`. Backup now resolves supported
  root paths before capture while still rejecting external links inside them.
  The filesystem regression failed with this provider layout before the fix and
  passed afterward, including an explicit unsafe nested-link rejection.
- A late helper failure marker could block verification after a complete manifest
  had already been accepted. Once verification starts, stored object hashes are
  authoritative; helper upload receipts no longer override that phase. Tests
  retain the missing/corrupt-object deletion barriers with a late failure marker.

The earlier stopped-Boat guest-probe fix was also exercised: wake is persisted
before inspecting backup receipts. Failed backup attempts retained the source.
Boat's verification was explicitly rescheduled on the same accepted archive
after deploying the late-receipt fix, then completed normal retirement and restore.

The local filesystem test also passed interrupted-upload retry, corrupted-chunk
rejection before installation, 350-message/WAL and engine-state recovery,
credential exclusion, idempotent restore and existing-database protection.
Staging runtime observations existed for both original and replacement machines.
Usage exports had acknowledged events for both providers; some Boat events were
still pending at inspection with no recorded error. This is observation/export
evidence, not verified provider-cost settlement.

Both replacement workspaces were paused after acceptance, the temporary inspector
was stopped, and staging recovery returned to its default disabled state. No
production deployment was performed. Daytona full archive recovery remains untested.
