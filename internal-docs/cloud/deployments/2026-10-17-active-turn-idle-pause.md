# Active turn interrupted by idle pause

Production inspection on 2026-10-17 found a Boat workspace paused before its
Claude turn settled. This note records observed evidence separately from the
reproducible keepalive defect fixed in PR #899.

## Observed sequence (UTC)

- 07:25:14: the runtime recorded the turn starting.
- 08:01:23: the last pre-pause message was persisted; no `TurnSettled` event followed.
- 08:01:53: the production tail recorded its last summary request before the gap.
  Tail URLs redact workspace IDs, so this request alone cannot establish ownership.
- 08:12:35.750: the workspace usage ledger recorded Zuse's `pause` action.
- 08:29:20: the same sandbox started runtime generation 2.
- 08:29:22: startup recovery recorded an interrupted-turn error and settled the turn.

The runtime database had no question or permission inputs. The deployed signed
runtime was `2d41937acb9d0513393284ee1a20b98e2af9a38c` (app 0.22.1).
Read-only inspection confirmed the pause and retained transcript. It did not
identify the exception, if any, that stopped periodic active-work activity.
No prompt was replayed, runtime database modified, or machine replaced during
this investigation. A later attempt to inspect Git state was rejected by the
provider; commit/PR completion was therefore not independently verified.

## Reproduced defect and fix

`keepCloudRuntimeActive` caught typed failures but not Effect defects. Session
queries can convert SQL failures to defects. A defect in any dependency could
silently end this background loop, leaving the normal idle deadline unextended.
The fix catches non-interruption causes and retries on the next 30-second cycle;
normal shutdown interruption still terminates the loop.

Three regression cases inject a defect into session reads, input checks, and
activity publication. Each failed before the fix and now verifies continued
publication for eleven simulated minutes and termination on shutdown. Existing
checks for quiet active turns, idle turns, and approval-blocked turns still pass.

This is a verified failure mode, not proof of the historical exception. The fix
requires a runtime release; it has not been deployed by this investigation.
