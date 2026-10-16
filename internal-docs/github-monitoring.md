# GitHub transport and observation

Zuse's GitHub API calls use `packages/git/src/github-client.ts`. Server composition supplies the existing cloud credential broker; standalone desktop Git layers use host-appropriate environment tokens, then `gh auth token --hostname`. `gh-stack` remains the transport for stack workflows. PR checkout uses native Git after resolving authoritative PR metadata through the API.

## API reference

- [GitHub GraphQL PR schema](https://docs.github.com/en/graphql/reference/pulls): merge queue fields and mutation contracts.

## Boundaries and failure handling

Credentials, budgets, caches and validators are scoped by host and SHA-256 credential digest. Tokens never enter renderer RPCs. Authenticated organization RPCs install an internal GitHub request scope from the transport-verified member identity. Scheduler fanout and status authority include that actor scope; native Git and gh-stack reuse the existing immutable credential-helper context. Scope construction performs no network read. Cloud renewal forwards the immutable actor request to the existing broker; it does not fall back to broad desktop environment credentials after a broker denial. Desktop credential lookups coalesce and cache for five minutes. Expiry and rejection revoke credentials; changing environment credentials changes the cache identity. A still-valid token can survive a transient broker outage for a short retry interval.

The shared transport limits concurrency to eight, deadlines to 30 seconds, and response bodies to 8 MiB. Actions log redirects are fetched without the GitHub authorization header. Mutations execute once; neither ambiguous delivery nor a rate-limit response causes mutation replay. GraphQL errors inside HTTP 200 responses are failures.

GraphQL reads reserve estimated cost, using observed costs to raise subsequent estimates. Remaining quota observations can only lower the balance within a reset window, so out-of-order responses cannot restore spent quota. Background GraphQL reads preserve the final 10% for interactive operations. Primary limits pause the exhausted API bucket; secondary limits pause both. Retry/reset headers take precedence, with exponential cooldown from 30 seconds to 15 minutes otherwise.

Discovery and summaries use aliased GraphQL batches, pinned to one credential and priority. PR batches collect for 10ms, up to 25 entries; branch discovery collects up to 50 interactive entries for 50ms or 25 background entries for 500ms. Only compatible discovery reads can fall back to REST. Conditional checks that are unsupported stop probing that endpoint and use authoritative GraphQL reads. Other read errors remain visible instead of becoming confirmed absence.

Files, feedback, identity, workflow jobs and failed-check logs use REST. Paginated feedback additionally reads GraphQL thread resolution metadata. Checks page on the fixed head OID and reject head movement or incomplete counts; files validate their head after pagination. A response with incomplete checks cannot establish success.

## Scheduler and status authority

`apps/server/src/git/pr-monitor.ts` owns observation for subscribed checkout resources. Duplicate streams share a scheduler; releasing the final stream stops observation after the existing short reconnect grace period. Workspace snapshot reads only return local Git state and the server's last observation: they never initiate GitHub polling.

Visible pending/absent checks and unknown mergeability refresh every 45 seconds; settled checks every 60 seconds. Background streams sweep every two minutes. Fingerprints gate background detail reads. Pending checks, first observations, unknown mergeability and changed status force detail reads. Settled visible checks use conditional PR/check-run/status reads, reuse 304 responses, and get authoritative rereads every five minutes. Head changes clear their validators. Feedback revisions and a 30-minute safety interval invalidate complete feedback caches; unsuccessful pagination is never cached as complete.

Successful commands trigger an immediate server refresh and publish to other subscribers. Refresh authority fences discard superseded branch observations. Last-known-good status survives read failures for the same checkout branch and credential; account/branch changes revoke it. Rate-limit pauses do not count toward repeated read failures. After eight genuine failures, observation backs off to one attempt every five minutes and recovers automatically when reads succeed. Explicit refresh or reconnect retries immediately. Local Git read failures retain their explanation and also cool down instead of busy-looping. Local branch/config/remote metadata reads do not initialize the native Git authentication helper; API reads retain their actor-scoped credential resolver, and network Git commands still require the scoped helper environment.

The header, environment summary and PR pane share `resolveGitPrState` and `GitHubStatusNotice`. Background loading is silent. Static notices explain cached/offline, authentication, access, incomplete checks and cooldowns. Feedback revision changes invalidate hydrated details while retaining visible content. Stale or incomplete state cannot authorize immediate merge; server actions reread state, validate the local branch/head, and bind merge requests to the expected head OID.

## Deterministic request traces

`packages/git/test/unit/github-pull-requests.test.ts` exercises one simulated hour. The baseline uses the previous server cadence without jitter: open PRs every seven seconds, pending PRs every five seconds. Each fixture GraphQL response reports one point per query. These are measured synthetic requests and fixture costs, **not measured production quota savings**. API cost varies with GitHub's actual responses and connection sizes.

| Workload | Old GraphQL requests | New GraphQL requests / fixture points | Reduction | New REST requests |
| --- | ---: | ---: | ---: | ---: |
| One settled open PR, background | 515 | 60 | 88.3% | 0 |
| One PR with active CI, visible | 720 | 107 | 85.1% | 0 |
| Ten settled open PRs, one account, background | 5,150 | 60 | 98.8% | 0 |

The background workloads do not exercise conditional REST. Separate behavior tests verify 304 reuse and unsupported endpoints. The existing summary watcher used GraphQL through `gh pr view`; its REST baseline is zero for these workloads, so a REST percentage reduction is undefined. Live account/enterprise and cloud broker smoke tests remain necessary before making a production quota claim.

Behavior coverage also includes credential isolation/expiry, bounded concurrency, shutdown cancellation, out-of-order balances, secondary cooldowns, ambiguous mutations, edited remarks, over 100 checks, changing heads during pagination, local merge head mismatch, branch changes and snapshot reads without polling. `apps/renderer/test/integration/github-status.browser.mjs` mounts the actual notice, resolver and PR menu in Chrome for repeatable status verification.

## Reliability follow-up (2026-10-16)

A cloud gateway connection is not proof that its runtime can answer RPC. Shared client handshake negotiation has a 30-second deadline, including retained-protocol negotiation. Timeout disposes the scoped transport and returns control to the existing connection supervisor. It never retries a mutation or infers an older protocol from a network failure.

During cloud startup, an `online` runtime only bypasses the startup timeout while its recorded credential remains valid. Reconciliation wakes at the earlier of credential expiry and idle expiry; an expired credential goes through the existing startup-failure path, retaining the sandbox, chat, and session for in-place recovery. Credentials can renew normally without imposing a fixed deadline on valid agent authentication preparation.

The October 16 Lapras startup failure was traced to `fs.watch` throwing `ENOSPC` while waiting for `/var/lib/zuse/workspace/repository-ready`, even though the ready marker already existed. Repository startup now checks durable markers directly and polls sequentially every 250ms only while pending. It allocates no watcher, stops with the runtime scope, preserves failure-marker precedence, and reports filesystem errors through the typed startup failure path. This prevents watcher exhaustion from masquerading as unavailable GitHub status.

## GitHub observations independent of execution environments

New desktop and mobile clients separate checkout identity from GitHub API reads:

- `git.githubContext` and the optional `githubTarget` in `git.workspaceSnapshot` expose repository host, owner/name, branch, fork owner, and observed checkout commit. They only read local Git metadata. Desktop persists this identity with its workspace projection; mobile persists it with downloaded checkout metadata. Cloud catalog metadata provides a repository/branch fallback before the runtime is reachable.
- Desktop personal workspaces call `github.observe` on the owning desktop, regardless of which machine owns the checkout. It uses desktop GitHub credentials; if these are missing and a user is signed in, the client can use the account GitHub connection. Organization workspaces and hosted clients use the account connection directly.
- Mobile calls `cloud.github.observe` through authenticated account HTTP. It never reads GitHub through the execution machine's `gh` login or wakes a sandbox to get PR status. When a machine is already connected, mobile can refresh checkout identity separately.
- The account endpoint rechecks the authenticated user's connection and the selected workspace owner's installation/repository policy before reading cached data. It uses the user's GitHub App token; it neither falls back to a bot token nor returns credentials. Execution credentials remain repository-scoped through the existing broker. The worker caches completed observations for 15 seconds, partitioned by user, workspace owner, credential fingerprint, and target; it does not share in-flight I/O across worker requests.
- `GitHubObservations` in `packages/git` owns PR/check/review/comment/file reads for both transports and the legacy Git service. The shared client observer coalesces subscribers, polls every minute, bounds each status request to 30 seconds, retries with backoff, respects GitHub retry deadlines, and retains the last success during transient failures. Authentication/access failures clear private cached content. Account and workspace switches cancel observations and fence late responses.
- New desktop subscriptions request `localOnly` workspace events, avoiding duplicate sandbox GitHub polling. Older clients retain the previous monitor protocol; older runtimes may continue legacy polling until updated, but new clients use their retained/catalog identity for independent GitHub reads.

Git status, diffs, commits, pushes, checkout operations, and existing mutation/agent workflows still belong to the execution environment. This change moves status and PR-detail reads; it does not make local checkout state fresh while a machine is offline. GitHub App authorization, the account API, and GitHub itself can still fail independently, with stale data and explicit reconnect/retry states rather than an indefinite loading indicator. The account endpoint must be deployed with the updated clients; deploy the API first.
