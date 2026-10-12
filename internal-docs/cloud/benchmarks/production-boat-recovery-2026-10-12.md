# Production Boat startup failure and recovery — 2026-10-12

## Failure

An organization workspace remained on “Fetching repository…” even though its
bootstrap had exited with code 128. Boat later archived the machine. The API
still recorded setup/online because its initial runtime activation moved to
verification-needed before the existing bootstrap failure check could run.
Sending another message scheduled reconciliation but did not release that hold.

The image carried runtime `fcbd8b8ab976ab7c929b5671f0366129ae59147f`
(protocol 6), plus an older globally configured GitHub credential helper. That
helper sent POST with JSON content type but no request body: the current API
returned `400 invalid_request`. Runtime asset delivery had written the current
helper with mode 0600; the initial bootstrap's executable check selected the old
helper instead. The repository shell also lacked the initiating organization's
member context, which agent turns receive separately.

Two fixes are shipped by the API's launch assets:

- Repository setup gets its own initiating member/Slack context and invokes the
  delivered helper through Bash, overriding inherited helpers only in that
  process. Other agent turns do not inherit the initiating member's identity.
- Initial bootstrap keeps using the existing failure-marker checks while
  repository setup is pending. A failed bootstrap retires its activation and
  reports failure instead of hiding behind release verification.

The first hotfix supplied context but did not override the old helper. Its
production retry reproduced HTTP 400. Comparing the old request with a current
context-bearing request isolated the remaining helper selection failure. The
second hotfix addressed it; the regression test now checks both context and
helper selection.

## Recovery verification

The existing Boat machine and SQLite database were retained. Read-only checks
confirmed SQLite integrity and the original chat/session IDs before recovery.
The normal signed runtime activation mechanism updated this workspace to
`bfae6b0a3cf22eed8152e0abe27ffab889757487` (protocol 7). A narrowly scoped,
compare-and-set operator request scheduled the existing update/restart workflow;
it did not recreate the sandbox, replace SQLite, or resend a prompt.

After the final fix, Git fetched master and created the requested branch while
preserving an existing `.gitignore` modification. The original session accepted
the user's queued new message, persisted an assistant response, and completed
the turn. The API reported ready/online and confirmed the activation.

Production API version: `592412ff-46df-4f12-b922-32912326680a`.
PR: https://github.com/swarajbachu/zuse/pull/867

## Measured final recovery

Start: backend recovery request timestamp, **18:52:43.539 UTC**. This is an
already-awake Boat machine with the new runtime already downloaded from the
previous recovery attempt. These numbers do not establish fresh-machine startup
performance or desktop click-to-display latency. UTC timestamps from guest and
Worker clocks may include clock skew.

| Milestone | Elapsed | Interval since previous milestone |
| --- | ---: | ---: |
| Recovery request | 0 ms | — |
| Startup dispatch persisted | 610 ms | 610 ms: SQL request and scheduler transport, not split |
| Scheduler alarm begins | 628 ms | 18 ms |
| Restart decision | 1,042 ms | 414 ms: reconciliation/lease work, not split |
| Asset preparation begins | 1,540 ms | 498 ms: inspection/lease/memory checks, not split |
| Asset preparation completes | 1,901 ms | 361 ms |
| Runtime replacement begins | 2,092 ms | 191 ms: activation authorization/persistence, not split |
| Guest launcher enters | 2,559 ms | 467 ms, overlapping provider replacement |
| Provider replacement returns | 2,589 ms | 497 ms total provider call |
| Runtime exec | 2,612 ms | 53 ms after guest launcher |
| Runtime module loaded | 2,887 ms | 275 ms |
| Runtime initializes | 3,024 ms | 137 ms |
| Bootstrap request begins | 3,036 ms | 12 ms |
| Enrollment persisted | 3,140 ms | 104 ms |
| Bootstrap request completes | 4,355 ms | 1,319 ms total bootstrap round trip |
| Selected Claude credential ready | 4,371 ms | 16 ms; seeded credential check 0.2 ms |
| Gateway opens | 6,094 ms | 1,723 ms, overlaps repository work |
| Repository ready recorded | 7,763 ms | 3,392 ms after credentials; Git/helper/reporting not individually split |
| Bootstrap acknowledgement begins | 7,845 ms | 82 ms |
| Bootstrap acknowledgement returns | 8,067 ms | 223 ms; asynchronous |
| Mailbox starts | 8,997 ms | 1,234 ms after repository readiness; setup/reporting not individually split |
| Queued message leased | 9,334 ms | 337 ms |
| Session acceptance begins | 9,645 ms | 311 ms |
| Claude driver accepts message | **10,616 ms** | 971 ms |
| Mailbox acknowledgement begins | 10,618 ms | 2 ms |
| Mailbox acknowledgement returns | 10,791 ms | 173 ms |
| Assistant message persisted | **12,558 ms** | 1,942 ms after driver acceptance |
| Turn completes | **13,640 ms** | 1,082 ms |

Authentication within bootstrap: executor round trip 1,124 ms; executor work
418 ms and transport/placement overhead 706 ms. The ready-grant call took 377 ms,
with a parallel 106 ms authority timeout extension. Guest grant measurements:
28 ms readiness Node work, 36 ms grant Node boot, 50 ms total grant Node work,
5 ms grant script work, 1 ms sealing, no provider token refresh. These spans
nest/overlap; they must not be summed as sequential durations.

The original unsuccessful allocation took **42,581 ms** from its API request
to credentials-ready, before Git failed. Provider creation was recorded at
+7,443 ms, allocation completion at +38,281 ms, and shell entry at +39,964 ms.
The provider creation-to-allocation gap is not individually resolved by the
captured incident logs. That original cold-path result exceeds the Boat target;
the successful recovery above must not be substituted for it.

## Validation and limits

- Regression tests failed before each relevant change; 37 repository/activation
  tests pass after the final helper fix.
- 107 broader reconciler tests passed; API type checks, Biome, and shell syntax
  checks passed.
- Actual production Git fetch, original-session message acceptance, assistant
  persistence, turn completion, and activation confirmation were observed.
- Desktop display delivery and the user's unresponsive workspace menu were not
  directly inspected. No desktop release was needed for this API/script fix.
- Publishing a runtime release does not update every pinned runtime/project
  image. This incident included an explicit in-place update of one workspace.
