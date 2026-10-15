# Daytona sandbox provider

Daytona uses the shared sandbox adapter, encrypted provider connections, account
image builder, and runtime usage outbox. The adapter uses Daytona's REST APIs so
it works in Cloudflare Workers without a Node SDK.

## Configuration

Set the organization's default region in the Daytona dashboard before building
images or creating sandboxes. Shared regions are `us` and `eu`; `/shared-regions`
lists them, while `/regions` lists organization-specific regions. Explicitly
passing a target does not bypass a missing organization default.

Prepare and publish a credential-free Zuse base image:

```sh
DAYTONA_API_KEY=... DAYTONA_TARGET=us DAYTONA_REGION_ID=us \
  node infra/cloud-sandboxes/daytona-publish.mjs 20261011-1
```

The publisher builds runtime artifacts from the checkout, creates an isolated
Node 22 builder, runs the same `provision.sh` stages as the shared Dockerfile,
and publishes a disk snapshot. It does not modify existing workspace sandboxes.
It deletes its builder and intermediate seed snapshot afterward. Use a new
version for each publication. The first template was published and verified on
2026-10-11: snapshot `50bea693-01d9-4ea6-9d06-b8350106d06e`, version `20261011-1`,
2 vCPU, 4096 MiB RAM, and 10 GB disk. The installed Zuse CLI reports `0.1.6`
and Node reports `v22.23.3`. This snapshot predates the startup optimizations
merged in October 12 main and belongs to the original test organization.
Publish a fresh version from the current checkout in the active organization
before rollout; the publisher includes the shared bootstrap/runtime scripts.
An actual SQLite database in the Zuse user data
directory passed integrity and content checks after stop/start.

The rebased runtime was published on 2026-10-12 in the network-enabled
organization as snapshot `1fc5f01c-8e00-4490-b8c4-228b86a424c5`, version
`20261012-1` (2 vCPU, 4096 MiB RAM). Publication and builder cleanup completed.
The staging configuration pins this version. Its live lifecycle test passed on
2026-10-15, including BYOK credential rebinding, API connectivity, bounded guest
execution, persisted SQLite data, stop/start, private preview, and snapshot
restore. See [the staging deployment record](deployments/2026-10-15-daytona-staging.md)
for migration, deployment, and remaining verification details.

Configure the Worker with the values printed by the publisher:

- `DAYTONA_ADAPTER_ENABLED=true`
- `DAYTONA_TEMPLATE_ID`: immutable published snapshot ID
- `DAYTONA_TEMPLATE_VERSION`: published version
- `DAYTONA_VCPU_COUNT` and `DAYTONA_MEMORY_MIB`: actual snapshot dimensions
- `DAYTONA_TARGET`: optional region target
- `DAYTONA_API_KEY`: Worker secret for managed infrastructure access; optional
  for a BYOK-only deployment
- `DAYTONA_API_BASE_URL`: optional HTTPS API origin, normally omitted

Apply migration `0046_daytona_provider_connections` before deploying code that
accepts Daytona keys. Configure secrets using Wrangler's secret input; never put
keys in a Wrangler configuration or commit them. From `infra/api`,
`bun run secret:daytona` installs the staging secret and
`bun run secret:daytona:production` installs the production secret. Installing a
secret does not enable or deploy the provider.

Ordinary workspaces and account-image builds use open networking, following
ADR 0034. Daytona uses the organization's default egress policy and does not
request per-sandbox network overrides. Tier 3 network controls are not a
prerequisite for this path. Organization policies still need to permit the
Zuse API and the services used by the selected agents. Daytona support confirmed
that lower-tier accounts need an organization-level network exception or Tier 3
for these destinations; a sandbox allowlist cannot override the restriction.
On 2026-10-12, the approved network exception was redeemed in organization
`3e8b4bb0-e33b-4fbe-8083-6818e8e20893`. A fresh sandbox then reached both
`api-staging.zuse.sh` and `api.zuse.sh` (HTTP 404 at the root, successful TLS).
This unlocks Zuse-managed workspaces in that organization. A BYOK customer must
separately have suitable network access in their own Daytona organization.


The provider is not yet marked production-ready. Staging enables Daytona with
the verified template and a Worker secret; production does not configure Daytona. BYOK registration does not require a
platform-owned Daytona key, but it does require a prepared Zuse template.

## BYOK

Choose Daytona under Cloud provider keys. Key verification performs a read-only
lookup, then the shared connection service encrypts the key with account,
provider, and connection identity as authenticated context. Workspace and build
records pin the connection ID; rotating a key does not redirect existing
resources into another Daytona account. The optional template field can select
a compatible Zuse snapshot owned by the user's Daytona organization.

## Lifecycle semantics and limitations

- `started` is running. `stopped`, `paused`, and `archived` are paused. A 404 or
  `destroyed` means missing. Other states fail transiently; they never become
  running usage or evidence that an existing sandbox should be replaced.
- Pause disables automatic deletion before stopping, preserving disk rather
  than memory even for terminate-on-timeout builders. Resume starts the same
  sandbox and reports lost process continuity, so the shared runtime activation
  restarts the installed runtime against its existing data directory.
- Timeouts use Daytona's minute-granularity inactivity auto-stop. These are not
  exact wall-clock leases. Keepalive updates the interval and last activity;
  terminate-on-timeout additionally enables deletion after one stopped minute.
  A zero-minute deletion interval makes the sandbox permanently ephemeral and
  prevents the stop-and-capture image workflow, so Zuse does not use it. The
  adapter does not advertise exact allocation timeout support. See
  [Daytona persistence](https://www.daytona.io/docs/en/persistence/).
- Only open networking is supported. Open `setNetwork` performs no request;
  quarantine and restricted requests fail before allocation. Native live-machine
  forks, which require quarantine during identity reset, are not implemented.
- Snapshots stop the source and save its disk. Publication retries reuse an
  existing named snapshot and wait for active state. Snapshot creation does not
  promise preserved processes.
- Runtime process replacement reuses the shared fenced process supervisor,
  including the targeted fsync startup optimization. Short guest operations
  expose `runProcess` with exit status and bounded output so shared auth
  authority requests can use the optimized ready-grant path.
- Previews remain private and use signed URLs valid for one hour. Endpoint
  resolution must be repeated when opening a new connection after expiry.
- A snapshot fixes the compute profile. The adapter exposes one standard size
  and never sends CPU/memory overrides with snapshot-based allocation.

## Billing and rollout record

| Capability | Status |
| --- | --- |
| Runtime observations | Shared workspace/build inspection and durable outbox; local unit and PostgreSQL coverage |
| Confirmed provider cost | Not implemented; no approved exact-window settlement evidence |
| Invoice export | Daytona excluded from billing-enforced managed placement |
| BYOK billing | Provider charges the connected account; shared Zuse settlement bypass remains in force |
| Live sandbox lifecycle | Zuse image creation, file persistence, stop/start, signed preview, snapshot and restore verified |
| Live billing-processor delivery | Not verified |
| Production deployment | Not performed |

Do not convert inactivity samples, balance differences, or published price
estimates into customer charges. Complete provider-to-usage-outbox-to-billing-
processor verification for both workspace and image-build resources before
promoting managed placement.

## Verification

Run adapter tests and the opt-in live test:

```sh
bunx vitest run packages/sandbox-providers/test/unit/daytona.test.ts
DAYTONA_API_KEY=... DAYTONA_TEMPLATE_ID=... DAYTONA_TARGET=us \
  bunx vitest run packages/sandbox-providers/test/live/daytona.live.test.ts
```

The live test exercises BYOK rebinding, open networking, Zuse API connectivity, file persistence,
stop/start, a signed HTTP preview, and snapshot restore, then deletes its test
resources. It is not a substitute for a full account-image build and resumed
Zuse chat test against staging.

References: [platform API](https://www.daytona.io/docs/tools/api/),
[regions](https://www.daytona.io/docs/regions/),
[organization defaults](https://www.daytona.io/docs/en/organizations/).
