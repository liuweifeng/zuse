# Boxd missing base recovery — 2026-10-17

A production Boxd account image remained queued with no build output. Provider
logs showed `machines.create` returning NotFound before any sandbox was allocated.
Production referenced `zuse-base-v20260927-1`; a direct snapshot lookup confirmed
that name was missing. The error escaped reconciliation and the build retried
after its lease expired, leaving the UI in progress. This investigation did not
establish who or what removed the original snapshot.

## Recovery

Created an isolated temporary machine from the remaining clean base,
`zuse-base-vstaging-20261010`. Verified the runtime launcher and updater, Node 22,
empty repository storage, absent agent credentials and runtime identity, empty
runtime data and secret directories, and a successful runtime help invocation.
No account image or customer machine was used as the source.

Published the missing name `zuse-base-v20260927-1` as snapshot
`snap_d90031c360194e10b8e5ebf29d9a518d`, version 1, and verified it reached ready.
This restores the configured name; it is a replacement base, not a recovery of
the original September bytes. Existing account images and workspaces are not
modified by restoring this name.

## Preventing the silent queue loop

The Boxd adapter now implements the existing `validateTemplate` contract using
its shared snapshot resolver. Missing or unfinished templates enter the build
reconciler's existing visible `provider-template-unavailable` failure path.
Transient provider failures retain their retry behavior. This validation runs
for image preparation and does not add a lookup to workspace resume or fork.

Verification: 126 Boxd adapter tests, the queued-build missing-template
reconciler regression, package type checking, and applicable Biome checks.
