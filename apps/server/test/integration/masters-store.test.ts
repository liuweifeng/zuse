import { type Master, MasterError } from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { describe, expect, it } from "vitest";
import {
	masterCheckpoint,
	validateMasterSettings,
} from "../../src/master/state.ts";
import { MasterStore, MasterStoreLive } from "../../src/master/store.ts";
import { Migration0065Masters } from "../../src/persistence/migrations/0065_masters.ts";

const master = (id = "master-one"): Master => ({
	id,
	revision: 1,
	generation: 1,
	accountManaged: false,
	homeEnvironmentId: "local",
	workspaceId: `private-${id}`,
	status: "active",
	coordinatorEventSequence: 0,
	settings: {
		name: "Team",
		providerId: "claude",
		model: "test",
		instructions: "Ask before merging.",
		skills: [],
		modelGuidance: "",
		maxConcurrent: 4,
		maxFollowUps: 3,
	},
	repositories: [
		{ environmentId: "local", folderId: "repo", name: "Repository" },
	],
	workers: [],
	conversations: [],
	activeSessionId: null,
	entries: [],
	artifacts: [],
	createdAt: 1,
	updatedAt: 1,
});
const withStore = async (
	test: (
		runtime: ManagedRuntime.ManagedRuntime<
			MasterStore | SqlClient.SqlClient,
			SqlError
		>,
	) => Promise<void>,
) => {
	const database = sqliteLayer({ filename: ":memory:" });
	const runtime = ManagedRuntime.make(
		MasterStoreLive.pipe(Layer.provideMerge(database)),
	);
	try {
		await runtime.runPromise(Migration0065Masters);
		await test(runtime);
	} finally {
		await runtime.dispose();
	}
};
describe("persistent Master state", () => {
	it("reserves a repository once and rolls back a conflicting creation", () =>
		withStore(async (runtime) => {
			await runtime.runPromise(
				Effect.gen(function* () {
					const store = yield* MasterStore;
					yield* store.save(master(), null);
					expect(
						Result.isFailure(
							yield* store.save(master("other"), null).pipe(Effect.result),
						),
					).toBe(true);
					expect((yield* store.list()).map((value) => value.id)).toEqual([
						"master-one",
					]);
					yield* store.change("master-one", (value) => ({
						...value,
						repositories: [],
					}));
					yield* store.save(master("other"), null);
					expect((yield* store.list()).length).toBe(2);
				}),
			);
		}));
	it("commits receipts with state and rejects command identity reuse", () =>
		withStore(async (runtime) => {
			await runtime.runPromise(
				Effect.gen(function* () {
					const store = yield* MasterStore;
					yield* store.save(master(), null);
					yield* store.reserve("command", "master-one", "intent");
					const result = yield* store.commit(
						"command",
						store.change("master-one", (value) => ({
							...value,
							status: "paused",
						})),
					);
					expect(
						(yield* store.reserve("command", "master-one", "intent")).result,
					).toEqual(result);
					expect(
						Result.isFailure(
							yield* store
								.reserve("command", "master-one", "different intent")
								.pipe(Effect.result),
						),
					).toBe(true);
					expect((yield* store.get("master-one")).revision).toBe(2);
				}),
			);
		}));
	it("does not publish a receipt or partial state when a transaction fails", () =>
		withStore(async (runtime) => {
			await runtime.runPromise(
				Effect.gen(function* () {
					const store = yield* MasterStore;
					yield* store.save(master(), null);
					yield* store.reserve("interrupted", "master-one", "intent");
					const failed = yield* store
						.commit(
							"interrupted",
							Effect.gen(function* () {
								yield* store.change("master-one", (value) => ({
									...value,
									status: "stopped",
								}));
								return yield* Effect.fail(
									new MasterError({ reason: "power loss before commit" }),
								);
							}),
						)
						.pipe(Effect.result);
					expect(Result.isFailure(failed)).toBe(true);
					expect((yield* store.get("master-one")).status).toBe("active");
					expect(
						(yield* store.reserve("interrupted", "master-one", "intent"))
							.result,
					).toBeNull();
				}),
			);
		}));
	it("preserves artifact versions and full policy revisions", () =>
		withStore(async (runtime) => {
			await runtime.runPromise(
				Effect.gen(function* () {
					const store = yield* MasterStore;
					const sql = yield* SqlClient.SqlClient;
					yield* store.save(master(), null);
					yield* store.publish(
						"master-one",
						"plan",
						1,
						"First plan",
						(value) => value,
					);
					yield* store.publish(
						"master-one",
						"plan",
						2,
						"Revised plan",
						(value) => ({
							...value,
							settings: {
								...value.settings,
								instructions: "Never merge automatically.",
							},
						}),
					);
					expect((yield* store.artifact("master-one", "plan", 1)).content).toBe(
						"First plan",
					);
					expect((yield* store.artifact("master-one", "plan", 2)).content).toBe(
						"Revised plan",
					);
					const history = yield* sql<{
						state_json: string;
					}>`SELECT state_json FROM master_revisions WHERE master_id = 'master-one' AND revision = 1`;
					expect(history[0]?.state_json).toContain("Ask before merging.");
					expect(
						Result.isFailure(
							yield* store.save(master(), 1).pipe(Effect.result),
						),
					).toBe(true);
				}),
			);
		}));
	it("retains unfinished objectives and decisions across checkpoint renewal", () => {
		const original = {
			...master(),
			workers: [
				{
					environmentId: "cloud",
					folderId: "repo",
					chatId: "chat",
					sessionId: "session",
					objective: "Repair search",
					state: "active" as const,
					followUps: 2,
					lastEventSequence: 31,
				},
			],
			entries: [
				{
					id: "decision",
					kind: "decision" as const,
					text: "Which API?",
					status: "open" as const,
					author: "user",
					updatedAt: 1,
				},
			],
		};
		const checkpoint = JSON.parse(masterCheckpoint(original));
		expect(checkpoint.workers[0].lastEventSequence).toBe(31);
		expect(checkpoint.entries[0].text).toBe("Which API?");
		expect(() =>
			validateMasterSettings({ ...original.settings, maxFollowUps: -1 }),
		).toThrow();
		expect(() =>
			validateMasterSettings({ ...original.settings, maxConcurrent: 33 }),
		).toThrow();
	});
});
