# Agent Engine failure verification

The engine must keep local execution independent of account connectivity. Durable
jobs alone do not establish this: ingestion, recovery, and shutdown also need
bounded dependencies and explicit resource ownership.

## Repeatable Linux process check

Run `bun run --filter desktop test:engine-reliability`.

This builds the desktop engine and runs its supervisor and real Codex executable
against local scripted inference. A temporary linked-account HTTP server accepts
requests without responding. The test uses its own temporary profile and fixture
credentials; it does not modify the user's account or chats.

Assertions cover:

- Client disconnect and reconnect preserve the engine and durable data.
- Worker crash changes transport credentials and preserves stored data.
- Account HTTP failure does not block provider ingestion or lease renewal.
- An executing shell tool survives client detachment, and a busy engine refuses
  replacement.
- Worker loss cleans up the owned tool process, reaches a terminal turn, and does
  not repeat the shell command.
- Supervisor and authenticated idle shutdown remove the worker and endpoint.
- Changed engine builds are rejected before touching the database.

## Focused failure regressions

- `session-liveness.test.ts`: delivery admission precedes listener acquisition;
  this normal startup interval must not show execution-loss warnings. Expired
  leases still report loss, and provider silence remains distinct from failure.
- `conversation-event-runtime.test.ts` and `api-activity-lifetime.test.ts`:
  blocked account notifications cannot stop turn completion; notification
  backlog is bounded, and timeout or shutdown aborts HTTP work.
- `api-link-lifetime.test.ts`: an unavailable account control plane cannot hold
  engine boot; tunnel restoration and heartbeat requests follow service lifetime.
  Shared credential refresh is bounded, caller disconnect aborts connection
  requests, and unlink cancels work belonging to the old account connection.
- `cloudflared-install.test.ts`: canceled installation aborts its download.
- `ingestion-lease.test.ts`: blocked or failed recovery for one session does not
  prevent another session recovering; exact ownership fences and retryable
  leases remain intact.
- `codex-transport-lifetime.test.ts`: protocol EOF retires a live process and
  pending calls; noninteractive startup authentication is bounded and cancelable.
- `provider-startup-cleanup.test.ts`: missing optional capability replies cannot
  indefinitely block provider startup; required startup failures clean up.

These checks establish the covered failure behavior, not a guarantee for every
provider, operating system, or production outage. Long-running turns and human
approval waits are not capped by startup or network-request deadlines. Recovery
must inspect existing execution evidence rather than silently resending input.
