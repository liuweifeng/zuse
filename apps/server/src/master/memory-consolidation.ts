import { createHash } from "node:crypto";
import {
	FolderId,
	type Master,
	MasterError,
	MasterMemoryPage,
	MasterMemorySource,
} from "@zuse/contracts";
import {
	Effect,
	Option,
	Schedule,
	Schema,
	type Semaphore,
	Stream,
} from "effect";
import {
	MEMORY_PREFIX,
	memoryInbox,
	memoryIndex,
	memoryOf,
	memorySource,
	validateMemoryEdits,
} from "./memory.ts";
import type { MasterMemoryDreamer } from "./memory-dreamer.ts";
import { type MasterStore, masterFailure } from "./store.ts";

const identity = (value: string) =>
	createHash("sha256").update(value).digest("hex");
export function makeMemoryConsolidation({
	store,
	dreamer,
	mutationLock,
	environmentId,
	directory,
	ownsGeneration,
	coordinatorBusy,
}: {
	store: typeof MasterStore.Service;
	dreamer: Option.Option<typeof MasterMemoryDreamer.Service>;
	mutationLock: Semaphore.Semaphore;
	environmentId: string;
	directory: (masterId: string) => string;
	ownsGeneration: (master: Master) => Effect.Effect<boolean, MasterError>;
	coordinatorBusy: (master: Master) => Effect.Effect<boolean, MasterError>;
}) {
	const DreamResult = Schema.Struct({
		edits: Schema.Array(
			Schema.Struct({
				path: Schema.String,
				title: Schema.String,
				summary: Schema.String,
				content: Schema.String,
				sources: Schema.Array(MasterMemorySource),
				expectedVersion: Schema.Number,
				archived: Schema.Boolean,
			}),
		),
		consumed: Schema.Array(MasterMemorySource),
	});
	/** One auxiliary model turn at a time; provider work never holds the mutation lock. */
	return Effect.gen(function* () {
		const prepared = yield* mutationLock.withPermits(1)(
			Effect.gen(function* () {
				for (const master of yield* store.list()) {
					if (
						master.homeEnvironmentId !== environmentId ||
						master.status !== "active"
					)
						continue;
					const memory = memoryOf(master);
					if (!memory.config) continue;
					if (master.accountManaged) {
						if (!(yield* ownsGeneration(master))) continue;
					}
					if (yield* coordinatorBusy(master)) continue;
					const inbox = memoryInbox(master);
					const automaticId = `memory-auto:${master.id}:${identity(JSON.stringify(inbox.map(memorySource)))}`;
					const previousRun = memory.run;
					if (previousRun?.state === "running") {
						// A live run is awaited below. Seeing one here means its owner restarted.
						yield* store.change(master.id, (value) => ({
							...value,
							memory: {
								...memoryOf(value),
								run: {
									...previousRun,
									state: "failed",
									error:
										"Consolidation was interrupted. Retry when ready; no findings were consumed.",
									updatedAt: Date.now(),
								},
							},
						}));
						continue;
					}
					const queued = memory.run?.state === "queued";
					if (
						!queued &&
						(!memory.config.automatic ||
							!inbox.length ||
							(memory.run?.batchKey ?? memory.run?.id) === automaticId)
					)
						continue;
					const runId =
						previousRun?.state === "queued" ? previousRun.id : automaticId;
					if (!inbox.length) {
						yield* store.change(master.id, (value) => ({
							...value,
							memory: {
								...memoryOf(value),
								run: {
									id: runId,
									batchKey: memory.run?.batchKey,
									state: "done",
									error: null,
									updatedAt: Date.now(),
								},
							},
						}));
						continue;
					}
					const running = yield* store.change(master.id, (value) => ({
						...value,
						memory: {
							...memoryOf(value),
							run: {
								id: runId,
								state: "running",
								batchKey: automaticId,
								error: null,
								updatedAt: Date.now(),
							},
						},
					}));
					return { master: running, inbox, runId };
				}
				return null;
			}),
		);
		if (!prepared) return;
		const { master, inbox, runId } = prepared;
		const memory = memoryOf(master);
		const config = memory.config;
		const operation = Effect.gen(function* () {
			if (!config)
				return yield* Effect.fail(
					new MasterError({ reason: "Memory configuration is unavailable." }),
				);
			if (Option.isNone(dreamer))
				return yield* Effect.fail(
					new MasterError({ reason: "Memory model service is unavailable." }),
				);
			const pages: MasterMemoryPage[] = [];
			let size = 0;
			for (const topic of memory.topics
				.filter((topic) => !topic.archived && topic.author !== "user")
				.slice()
				.reverse()) {
				if (pages.length >= 8) break;
				const stored = yield* store.artifact(
					master.id,
					`${MEMORY_PREFIX}${topic.path}`,
					topic.version,
				);
				const page = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(MasterMemoryPage),
				)(stored.content);
				if (size + page.content.length > 32_000) continue;
				size += page.content.length;
				pages.push(page);
			}
			const cancelled = Stream.fromEffect(store.get(master.id)).pipe(
				Stream.repeat(Schedule.spaced("1 second")),
				Stream.filter(
					(value) =>
						value.homeEnvironmentId !== environmentId ||
						value.status !== "active" ||
						value.memory?.run?.id !== runId ||
						value.memory.run.state !== "running",
				),
				Stream.take(1),
				Stream.runDrain,
				Effect.andThen(
					Effect.fail(
						new MasterError({ reason: "Memory consolidation was cancelled." }),
					),
				),
			);
			const raw = yield* dreamer.value
				.generate({
					folderId: FolderId.make(master.workspaceId),
					cwd: directory(master.id),
					providerId: config.providerId,
					model: config.model,
					prompt: JSON.stringify({
						index: memoryIndex(master),
						topics: pages.map((page) => ({
							topic: page.topic,
							content: page.content,
						})),
						findings: inbox.map((entry) => ({
							...entry,
							source: memorySource(entry),
						})),
					}),
				})
				.pipe(Effect.raceFirst(cancelled));
			const result = yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(DreamResult),
			)(raw);
			if (result.edits.length > 8 || result.consumed.length > inbox.length)
				return yield* Effect.fail(
					new MasterError({
						reason: "Memory result exceeded its batch limits.",
					}),
				);
			const supplied = new Set(
				inbox.map((entry) => JSON.stringify(memorySource(entry))),
			);
			if (
				result.consumed.some(
					(source) => !supplied.has(JSON.stringify(source)),
				) ||
				new Set(result.consumed.map((source) => source.entryId)).size !==
					result.consumed.length
			)
				return yield* Effect.fail(
					new MasterError({
						reason: "Memory result consumed findings outside its input batch.",
					}),
				);
			for (const edit of result.edits) {
				const previous = memory.topics.find(
					(topic) => topic.path === edit.path,
				);
				if (previous && !pages.some((page) => page.topic.path === edit.path))
					return yield* Effect.fail(
						new MasterError({
							reason: "Memory result tried to edit an unloaded topic.",
						}),
					);
				if (
					edit.sources.some(
						(source) =>
							!supplied.has(JSON.stringify(source)) &&
							!previous?.sources.some(
								(old) =>
									old.entryId === source.entryId &&
									old.fingerprint === source.fingerprint,
							),
					)
				)
					return yield* Effect.fail(
						new MasterError({
							reason: "Memory result cited findings outside its input batch.",
						}),
					);
			}
			yield* mutationLock.withPermits(1)(
				Effect.gen(function* () {
					const current = yield* store.get(master.id);
					const currentMemory = memoryOf(current);
					if (
						current.homeEnvironmentId !== environmentId ||
						current.status !== "active" ||
						currentMemory.run?.id !== runId ||
						currentMemory.run.state !== "running"
					)
						return;
					if (current.accountManaged && !(yield* ownsGeneration(current)))
						return yield* Effect.fail(
							new MasterError({
								reason: "Zot ownership changed during consolidation.",
							}),
						);
					if (
						currentMemory.revision !== memory.revision ||
						inbox.some((entry) => {
							const latest = current.entries.find(
								(candidate) => candidate.id === entry.id,
							);
							return (
								!latest ||
								memorySource(latest).fingerprint !==
									memorySource(entry).fingerprint
							);
						})
					)
						return yield* Effect.fail(
							new MasterError({
								reason:
									"Memory or findings changed during consolidation. Retry against the latest versions.",
							}),
						);
					const topics = result.edits.length
						? yield* Effect.try({
								try: () =>
									validateMemoryEdits(current, result.edits, `dream:${runId}`),
								catch: masterFailure,
							})
						: currentMemory.topics;
					const consumed = new Map(
						currentMemory.consumed.map((source) => [source.entryId, source]),
					);
					for (const source of result.consumed)
						consumed.set(source.entryId, source);
					yield* store.publishMemory(
						master.id,
						result.edits.map((edit) => ({
							path: edit.path,
							version: edit.expectedVersion + 1,
							content: JSON.stringify({
								content: edit.content,
								topic: topics.find((topic) => topic.path === edit.path),
								evidence: [
									...(pages.find((page) => page.topic.path === edit.path)
										?.evidence ?? []),
									...inbox,
								].filter(
									(entry, index, entries) =>
										edit.sources.some(
											(source) =>
												source.entryId === entry.id &&
												source.fingerprint === memorySource(entry).fingerprint,
										) &&
										entries.findIndex(
											(candidate) =>
												candidate.id === entry.id &&
												memorySource(candidate).fingerprint ===
													memorySource(entry).fingerprint,
										) === index,
								),
							}),
						})),
						(value) => ({
							...value,
							memory: {
								...memoryOf(value),
								topics,
								consumed: [...consumed.values()],
								revision: currentMemory.revision + 1,
								run: {
									id: runId,
									batchKey: memory.run?.batchKey,
									state: "done",
									error: null,
									updatedAt: Date.now(),
								},
							},
						}),
					);
				}),
			);
		});
		yield* operation.pipe(
			Effect.catch((error) =>
				mutationLock
					.withPermits(1)(
						store.change(master.id, (value) => {
							const current = memoryOf(value);
							if (current.run?.id !== runId || current.run.state !== "running")
								return value;
							return {
								...value,
								memory: {
									...current,
									run: {
										...current.run,
										state: "failed",
										error: masterFailure(error).reason.slice(0, 500),
										updatedAt: Date.now(),
									},
								},
							};
						}),
					)
					.pipe(Effect.asVoid),
			),
		);
	});
}
