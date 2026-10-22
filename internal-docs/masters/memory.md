# Learned Zot memory

Zots keep learned memory outside provider context, alongside their existing durable notes and artifact versions. A compact index links to versioned topics, with attributed findings and a separate bounded consolidation turn; no external memory runtime or deployment stack is imported.

## Use and boundaries

Open the Z's Details panel, expand Memory, select a consolidation model with the shared model picker, and save. Consolidate runs one bounded batch; automatic consolidation is optional and off by default. The current release supports Claude and Zuse native harness for the auxiliary model because those adapters enforce text-only execution. Other coordinator providers can still read and publish memory. Unsupported consolidation selections remain visible and cannot be saved; providers are never silently substituted.

Workers receive CLI instructions to read the compact index and retrieve specific topics through scoped Zot queries. They submit reusable findings through the existing report query. Memory is data, not authority: user instructions, permissions, decisions, objectives and current Git/execution state remain separate. Observed repository chats are not automatically ingested or instructed. Consolidation does not renew chats or eliminate context growth; the existing explicit fresh-chat checkpoint remains necessary.

The native panel supports topic search by title/path/summary, on-demand content loading, editing, archival, historical versions and restoration into a new version. User edits take ownership of that topic; automated consolidation cannot overwrite it. Each stored page includes immutable evidence snapshots, author metadata and exact source fingerprints. Updating a finding cannot silently change an old page's evidence. Generated screens and CLI/tool readers use the same scoped server commands.

## Storage and recovery

`memory.ts` owns validation, source fingerprints, bounded inbox selection and index construction. `memory-consolidation.ts` owns job preparation, cancellation, validation and publication. `memory-dreamer.ts` uses the existing provider service with a unique ephemeral session in the private Zot workspace. It bypasses Git credential resolution for the auxiliary turn and disables tools, delegation, workspace hooks and repository instructions; the model returns structured JSON only. Native execution rejects even a fabricated tool call. Claude receives an empty tool/agent/MCP set and disabled hooks. The response is limited to 64 KB and the turn to 90 seconds, with provider cleanup on every exit.

A batch contains at most 16 complete findings and 32 KB of text. The model receives an index of at most 8 KB and up to eight editable topic pages totalling 32 KB. Each topic is limited to 16 KB, with at most 64 topics and 32 source references per page. All active topic links survive index compaction. Oversized findings remain pending instead of being truncated and marked consumed.

The job runs only on the active home, waits for an idle coordinator, and checks account ownership before running and before publication. Only one auxiliary turn runs at a time per server. Publication checks the memory revision and every supplied source fingerprint again. Page versions, evidence, consumed fingerprints and successful job state commit in one SQLite transaction. Command receipts deduplicate explicit requests; batch identities prevent repeated automatic processing of unchanged findings.

Cancellation aborts the auxiliary provider and disables automatic consolidation so it cannot immediately restart. Pausing/stopping, moving home or changing the job invalidates a running result. A persisted running job found after restart becomes a visible failure without consuming findings; the user can retry. No automatic failover or paid retry loop is introduced. Existing home transfers carry memory state, receipts, revision history and every artifact version with the Zot.

## Validation

`master-memory.test.ts` covers changed findings, bounded batches, all 64 index links and fresh-chat checkpoints. `masters-supervision.test.ts` covers publication receipts, evidence history, stale/forged sources, protected user edits, restoration, source changes during model work, cancellation, interrupted jobs and transferred versions. `harness-native-runtime.test.ts` verifies that text-only turns expose no tools and cannot execute fabricated commands.

Browser checks against an isolated real server exercised the native panel's current and historical topic reads, restoration into a new version, editing, archival and the shared model-picker popover at desktop and 390px widths. The full app's browser startup failed while fetching an unrelated right-pane chunk before reaching memory; this is not an end-to-end pass. Production renderer build, scoped behavior tests, type checks, architecture checks and i18n checks passed. Paid Claude/native model calls and native desktop interaction still require smoke verification with a working authenticated installation.
