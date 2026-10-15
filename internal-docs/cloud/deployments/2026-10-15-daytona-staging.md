# Daytona staging deployment — 2026-10-15

Source: working tree on `swarajbachu/daytona-provider-setup`, based on main
`2e94d0eb`. No production deployment was performed.

## Database

Used the Mac's authenticated Wrangler to deploy a temporary, token-protected
migration Worker bound only to staging Hyperdrive `dfc67e0586ff4c288cb645ed63c65d9a`.
Its static migration plan applied `0040` through `0046` in one transaction and
recorded the repository SQL hashes and journal timestamps. Ran the existing
`ensureBillingIndex` post-migration helper. A subsequent audit found no migrations
pending after the current high-water mark, 50 ledger entries, and Daytona in the
provider-connection check constraint. The temporary Worker was deleted.

Three older ledger entries have hashes/timestamps absent from the current
journal. The current `0029_model_connections` ledger timestamp is also absent,
but both model-connection tables already exist with the expected column types
and nullability. Those tables and historical records were preserved; no old
migration was replayed or marked applied. The protected runner pinned the exact
observed legacy records before accepting the new migration plan.

## API

- Worker: `zuse-relay-staging` at `https://api-staging.zuse.sh`.
- Deployed version: `fac151b0-3485-4842-b590-3ccbf346eb7e`.
- Previous version before the secret update: `df8ac530-ddbd-434b-83bc-10bb070d75b8`.
- Published Daytona snapshot: `1fc5f01c-8e00-4490-b8c4-228b86a424c5`, version
  `20261012-1`, 2 vCPU / 4096 MiB, in the network-enabled organization.
- `DAYTONA_API_KEY` installed as a Worker secret. Credential values were not
  included in source or deployment bundles.
- The Mac received the same Worker bundle validated in the cloud workspace:
  SHA-256 `9217bc4c3b9de33622d7c7e36aad5fddbc34c59fa2d02b3c7f64396a1f35c8c2`.
- Only the five Daytona configuration variables differed from the previous
  staging configuration. The default provider remains `box`.

The transferred prebuilt bundle requires explicit Text-module rules for its
nine hashed runtime assets. The first upload was rejected for missing modules;
the corrected package attached all nine and deployed successfully. This is a
prebuilt-artifact concern; ordinary source builds use the existing source rules.
Temporary transfer services were stopped after deployment.

## Verification and remaining work

The live Daytona test passed using the current account and new snapshot. It
covers BYOK rebinding, Zuse staging API connectivity, short guest commands with
exit/stdout receipts, runtime CLI execution, SQLite/file persistence across
stop/start and snapshot restore, private HTTP previews, and test-resource cleanup.

The rebased implementation passed 554 targeted unit/UI/PostgreSQL tests,
provider/API/renderer type checks, Biome, and architecture checks. The deployed
provider, connection, and image API routes return the expected unauthenticated
401; the root returns 404. Cloudflare settings confirm the enabled adapter,
intended snapshot/resources, and presence of the Daytona secret.

Authenticated account-image creation was subsequently verified below. Full
chat/resume delivery and live workspace/build usage delivery to the billing
processor remain unverified.
The direct adapter test and unauthenticated endpoint checks do not establish
those flows. Do not promote production readiness or billable managed placement
until the provider usage and billing release gates are satisfied.

Rollback: redeploy the previous Worker version. Leave the additive database
migrations in place; the provider constraint expansion does not invalidate
existing providers or connections.

## Image-build incident and fixes

The first signed-in build (`image_YzlFvwLk9PNpdWe-`) remained queued and ended
with `project-start-timeout`. A protected, temporary probe in the deployed
Worker reproduced the cause: Workers rejects `fetch`'s `redirect: "error"`
option before sending the request. The adapter now uses `manual` and rejects
redirect responses without forwarding credentials. A regression test failed
before the fix and passed afterward.

The next build (`image_OlMJQwdHgOs2K-qK`) allocated a sandbox, installed the
runtime/toolchain, cloned the repository, and retained 1,265 bytes of logs. It
then failed with `snapshot-rejected`: an auto-delete interval of zero creates
an irreversibly ephemeral Daytona sandbox. A disposable live reproduction
confirmed that disabling deletion is rejected for such a sandbox. Builders now
use a one-minute stopped auto-delete interval; explicit snapshot capture first
disables deletion. Both pause-on-timeout and terminate-on-timeout live tests
passed, including SQLite persistence and snapshot restore (41.96 seconds total).

Both fixes are deployed to staging version
`2e43f397-a456-490d-9a35-0f343a9fb606`. A fresh source build exactly matches the
patched deployed JavaScript (SHA-256
`46306a626f25b8c140745bb3e7b33e51f65aad2406a95408b19577a732f8693a`).
Temporary diagnostic routes, logging instrumentation, and read-only Hyperdrive
audit Workers were removed. The user was asked for a fresh build because
Daytona cannot convert an already-created ephemeral builder into a persistent
one. The fresh attempt was subsequently verified below.

The longer diagnostic sample also contained database connection-acquisition
timeouts for unrelated workspace reconciliation. These were not the cause of
the reproduced Daytona fetch failure and are not fixed by these changes.


## Signed-in image build verified

The user-triggered managed build `image_dZdg4pCkhDTVYkUl` reached `ready`,
revision 4, with no error code. Daytona snapshot
`612e295b-1b6f-40cf-b728-76ec4bc441ec` was independently confirmed `active`, and
the same ID is persisted on the ready build. Zuse retained 1,192 bytes of build
logs and cleared the builder sandbox ID after cleanup. This verifies the real
account-image path through repository preparation, snapshot publication, and
image adoption. It does not yet verify a chat launched from that image or
billing-processor delivery. The temporary read-only audit Worker was deleted.
