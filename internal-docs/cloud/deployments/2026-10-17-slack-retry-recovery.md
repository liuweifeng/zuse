# Slack workspace retry recovery — 2026-10-17

The Legion Slack workspace's initial repository fetch failed because an idle
Slack workspace referenced a synthetic launch-message ID without a message row.
Production API authorization was fixed to accept only that workspace's exact
server-persisted Slack setup identity. Other message identities still require
the usual ownership and content checks.

A subsequent web Retry reached the API successfully but exposed two additional
recovery problems:

1. The workspace's old Boat account image had been retired. Queued recovery
   attempted image-based replacement even though the enrolled machine existed.
   Recovery now uses the shared fenced restart on that machine. The regression
   removes the image and prohibits machine deletion or replacement.
2. Zuse project registration had appended `.context` to the tracked `.gitignore`.
   Fetch succeeded but first-branch checkout rejected that local modification.
   First-branch checkout now matches existing-branch recovery: with a clean
   index on managed images, Git merges local changes during the switch. Conflicts
   remain explicit Git conflicts; native snapshots and staged changes keep the
   conservative path.

The failed guest had exited while the API still displayed repository preparation.
After verifying the guest failure marker and absence of runtime processes, an
operator transaction queued recovery for this exact account/workspace/machine
only. The update required the observed setup state, repository-fetch status,
ready desired state and no active reconciliation lease. It preserved the resource
IDs and user data, removed stale bootstrap receipt/install/diagnostic fields,
marked the failed runtime activation as failed, and incremented the revision.
The previous record was saved privately in the incident workspace. No customer
repository changes were discarded and no replacement machine was allocated.

Production API version `da92d02b-3931-4eb5-ae42-99010ff4062b` includes both recovery
fixes. At 07:03:49 UTC the original workspace was ready with `agent-running` and
its queued message accepted. This verifies startup recovery, not completion of
the user's requested task.

Validation: 112 reconciler tests, 17 repository tests, API types and applicable
Biome checks passed. Production deployment also passed live Boat/E2B/Boxd base
allocation, runtime execution and cleanup checks.
