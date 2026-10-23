import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppPaths } from "../src/app-paths.ts";
import { ConfigStoreServiceLive } from "../src/config-store/layers/config-store-service.ts";
import { ConfigStoreService } from "../src/config-store/services/config-store-service.ts";
import { MigrationsLive } from "../src/persistence/migrations.ts";

const [directoryArg, stage] = process.argv.slice(2);
assert(
	directoryArg &&
		["stable-create", "preview", "stable-return", "preview-return"].includes(
			stage ?? "",
		),
	"Expected an isolated directory and probe stage",
);
const directory = resolve(directoryArg);
mkdirSync(directory, { recursive: true });
process.env.ZUSE_CONFIG_DIR = join(directory, "config");
delete process.env.ZUSE_CONFIG_PROFILE;
delete process.env.ZUSE_DEV_CONFIG;
delete process.env.VITE_DEV_SERVER_URL;
const sqlite = sqliteLayer({ filename: join(directory, "zuse.sqlite") });
const config = ConfigStoreServiceLive.pipe(
	Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
	Layer.provide(NodeServices.layer),
);
const runtime = ManagedRuntime.make(
	Layer.mergeAll(sqlite, MigrationsLive.pipe(Layer.provide(sqlite)), config),
);
const masterTables = [
	"masters",
	"master_repositories",
	"master_artifacts",
	"master_revisions",
	"master_commands",
	"master_target_commands",
	"master_transcripts",
	"master_snapshots",
	"master_transfers",
	"master_worker_origins",
	"master_interrupts",
];
const snapshotPath = join(directory, "masters-preview.json");
const masterSnapshot = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const snapshot: Record<string, unknown> = {};
	for (const table of masterTables) {
		// Identifiers are a fixed allowlist, never input from the database or CLI.
		snapshot[table] = (yield* sql.unsafe(
			`SELECT * FROM ${table} ORDER BY rowid`,
		)).map((row) => ({ ...row }));
	}
	return snapshot;
});
const verifyMasterSnapshot = () =>
	Effect.gen(function* () {
		assert.deepEqual(
			yield* masterSnapshot,
			JSON.parse(readFileSync(snapshotPath, "utf8")),
			"Preview Master data changed while using Stable",
		);
	});
try {
	if (stage === "stable-return" || stage === "preview-return") {
		await runtime.runPromise(verifyMasterSnapshot());
	}
	await runtime.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const settings = yield* ConfigStoreService;
			const now = "2026-01-01T00:00:00.000Z";
			if (stage === "stable-create") {
				yield* sql`INSERT INTO projects (id, path, name, created_at, updated_at) VALUES ('compat-project', '/tmp/compat-project', 'Compatibility', ${now}, ${now})`;
				yield* settings.updateSettings({
					appearanceMode: "dark",
					onboardingCompleted: true,
				});
			} else {
				const previous =
					stage === "preview"
						? "stable-create"
						: stage === "stable-return"
							? "preview"
							: "stable-return";
				const chats =
					yield* sql`SELECT title FROM chats WHERE id = ${`compat-${previous}`}`;
				assert.equal(chats[0]?.title, previous);
				const sessions =
					yield* sql`SELECT title FROM sessions WHERE id = ${`compat-${previous}`}`;
				assert.equal(sessions[0]?.title, previous);
				const saved = yield* settings.getSettings();
				assert.equal(
					saved.appearanceMode,
					stage === "stable-return" ? "light" : "dark",
				);
				assert.equal(saved.onboardingCompleted, true);
				yield* settings.updateSettings({
					appearanceMode: stage === "stable-return" ? "dark" : "light",
				});
				yield* sql`UPDATE sessions SET title = 'Read and modified' WHERE id = ${`compat-${previous}`}`;
			}
			const id = `compat-${stage}`;
			yield* sql`INSERT INTO chats (id, project_id, title, created_at, updated_at) VALUES (${id}, 'compat-project', ${stage}, ${now}, ${now})`;
			yield* sql`INSERT INTO sessions (id, project_id, title, provider_id, model, status, chat_id, created_at, updated_at) VALUES (${id}, 'compat-project', ${stage}, 'codex', 'gpt-5', 'idle', ${id}, ${now}, ${now})`;
			yield* sql`UPDATE chats SET active_session_id = ${id} WHERE id = ${id}`;
			assert.equal((yield* sql`PRAGMA quick_check`)[0]?.quick_check, "ok");
			assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
		}),
	);
	if (stage === "preview" || stage === "preview-return") {
		await probeMasterData(stage);
	} else if (stage === "stable-return") {
		// Stable must be able to write ordinary data without understanding Masters.
		await runtime.runPromise(verifyMasterSnapshot());
	}
	await runtime.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			assert.equal((yield* sql`PRAGMA quick_check`)[0]?.quick_check, "ok");
			assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
		}),
	);
	console.log(`Desktop data compatibility: ${stage} passed`);
} finally {
	await runtime.dispose();
}

/** Candidate-only imports: this same script is copied into the actual Stable checkout. */
async function probeMasterData(candidateStage: "preview" | "preview-return") {
	const [
		{ Master, MasterMemoryPage, MasterTargetResult },
		{ makeMasterStore },
		{ memorySource },
		{ Schema },
	] = await Promise.all([
		import("@zuse/contracts"),
		import("../src/master/store.ts"),
		import("../src/master/memory.ts"),
		import("effect"),
	]);
	await runtime.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const store = yield* makeMasterStore;
			const masterId = "compat-master";
			const commandId = "compat-master-publish";
			const fingerprint = "compat-master-publish-v1";
			if (candidateStage === "preview") {
				const now = "2026-01-01T00:00:00.000Z";
				yield* sql`INSERT INTO projects (id,path,name,created_at,updated_at) VALUES ('compat-master-workspace','/tmp/compat-master-workspace','Private coordinator',${now},${now})`;
				for (const sessionId of [
					"compat-coordinator-history",
					"compat-coordinator-active",
				]) {
					yield* sql`INSERT INTO chats (id,project_id,title,created_at,updated_at) VALUES (${sessionId},'compat-master-workspace',${sessionId},${now},${now})`;
					yield* sql`INSERT INTO sessions (id,project_id,title,provider_id,model,status,chat_id,created_at,updated_at) VALUES (${sessionId},'compat-master-workspace',${sessionId},'claude','compatibility-only','idle',${sessionId},${now},${now})`;
					yield* sql`UPDATE chats SET active_session_id = ${sessionId} WHERE id = ${sessionId}`;
				}
				const finding = {
					id: "compat-finding",
					kind: "note",
					text: "Run the focused behavior tests.",
					status: "open",
					author: "compat-environment:compat-stable-create",
					updatedAt: 1,
				} as const;
				const source = memorySource(finding);
				const topic = {
					path: "testing.md",
					title: "Testing",
					summary: "Repository test guidance",
					version: 1,
					sources: [source],
					author: "user",
					updatedAt: 1,
					archived: false,
				};
				const master = Schema.decodeUnknownSync(Master)({
					id: masterId,
					revision: 1,
					generation: 1,
					accountManaged: false,
					homeEnvironmentId: "compat-environment",
					workspaceId: "compat-master-workspace",
					status: "paused",
					settings: {
						name: "Compatibility Master",
						providerId: "claude",
						model: "compatibility-only",
						instructions: "Ask before merging.",
						skills: ["test-first"],
						modelGuidance: "Prefer focused tests.",
						maxConcurrent: 4,
						maxFollowUps: 3,
					},
					repositories: [
						{
							environmentId: "compat-environment",
							folderId: "compat-project",
							name: "Compatibility",
						},
					],
					workers: [
						{
							environmentId: "compat-environment",
							folderId: "compat-project",
							chatId: "compat-stable-create",
							sessionId: "compat-stable-create",
							objective: "Preserve existing work",
							state: "paused",
							followUps: 1,
							lastEventSequence: 7,
						},
					],
					conversations: [
						{
							chatId: "compat-coordinator-history",
							sessionId: "compat-coordinator-history",
							environmentId: "compat-environment",
							createdAt: 1,
							checkpoint: "Previous coordinator checkpoint",
						},
						{
							chatId: "compat-coordinator-active",
							sessionId: "compat-coordinator-active",
							environmentId: "compat-environment",
							createdAt: 2,
							checkpoint: "Current coordinator checkpoint",
						},
					],
					activeSessionId: "compat-coordinator-active",
					coordinatorEventSequence: 5,
					entries: [
						finding,
						{
							id: "compat-decision",
							kind: "decision",
							text: "Choose rollout date",
							status: "open",
							author: "user",
							updatedAt: 1,
						},
					],
					artifacts: [],
					memory: { revision: 0, topics: [], consumed: [], run: null },
					createdAt: 1,
					updatedAt: 1,
				});
				yield* store.save(master, null);
				for (const version of [1, 2]) {
					const page = Schema.decodeUnknownSync(MasterMemoryPage)({
						content: `Test guidance version ${version}`,
						topic: { ...topic, version },
						evidence: [finding],
					});
					yield* store.publishMemory(
						masterId,
						[{ path: topic.path, version, content: JSON.stringify(page) }],
						(value) => ({
							...value,
							memory: {
								revision: version,
								topics: [page.topic],
								consumed: [source],
								run: null,
							},
						}),
					);
				}
				for (const version of [1, 2]) {
					yield* store.publish(
						masterId,
						"compat-plan",
						version,
						`Plan version ${version}`,
						(value) => ({
							...value,
							artifacts: [
								{
									id: "compat-plan",
									title: "Plan",
									kind: "markdown",
									version,
									pinned: true,
									author: "user",
									updatedAt: version,
								},
							],
						}),
					);
				}
				yield* store.reserve(
					commandId,
					masterId,
					fingerprint,
					JSON.stringify({ action: { _tag: "control", status: "paused" } }),
				);
				yield* store.commit(
					commandId,
					store.change(masterId, (value) => ({ ...value, status: "paused" })),
				);
				const targetResult = Schema.decodeUnknownSync(MasterTargetResult)({
					chats: [],
					chatId: "compat-stable-create",
					sessionId: "compat-stable-create",
					text: "",
					events: [],
				});
				yield* sql`INSERT INTO master_target_commands VALUES ('compat-target-receipt','compat-target-fingerprint',${JSON.stringify(targetResult)},${masterId},'compat-project')`;
				yield* sql`INSERT INTO master_transcripts VALUES (${masterId},'compat-coordinator-history','# Preserved coordinator transcript')`;
				yield* sql`INSERT INTO master_worker_origins VALUES ('compat-stable-create',${masterId},'compat-environment','compat-project')`;
				writeFileSync(snapshotPath, JSON.stringify(yield* masterSnapshot));
			} else {
				const master = yield* store.get(masterId);
				assert.equal(master.settings.instructions, "Ask before merging.");
				assert.equal(master.conversations.length, 2);
				assert.equal(
					master.entries.find((entry) => entry.kind === "decision")?.status,
					"open",
				);
				assert.equal(master.workers[0]?.lastEventSequence, 7);
				assert.equal(master.memory?.topics[0]?.version, 2);
				assert.equal(master.memory?.consumed.length, 1);
				for (const version of [1, 2]) {
					const page = Schema.decodeUnknownSync(
						Schema.fromJsonString(MasterMemoryPage),
					)(
						(yield* store.artifact(masterId, "memory/testing.md", version))
							.content,
					);
					assert.equal(page.content, `Test guidance version ${version}`);
					assert.equal(
						page.evidence[0]?.text,
						"Run the focused behavior tests.",
					);
					assert.equal(
						(yield* store.artifact(masterId, "compat-plan", version)).content,
						`Plan version ${version}`,
					);
				}
				const receipt = yield* store.reserve(commandId, masterId, fingerprint);
				assert.equal(receipt.phase, "done");
				assert.equal(receipt.result?.revision, master.revision);
				const revisions = yield* sql<{
					state_json: string;
				}>`SELECT state_json FROM master_revisions WHERE master_id = ${masterId} ORDER BY revision`;
				assert.equal(revisions.length, master.revision);
				for (const revision of revisions)
					Schema.decodeUnknownSync(Schema.fromJsonString(Master))(
						revision.state_json,
					);
				const nextCommand = "compat-master-return-write";
				yield* store.reserve(nextCommand, masterId, "compat-return-write");
				const previousPage = Schema.decodeUnknownSync(
					Schema.fromJsonString(MasterMemoryPage),
				)((yield* store.artifact(masterId, "memory/testing.md", 2)).content);
				const nextPage = {
					...previousPage,
					content: "Memory after Stable return",
					topic: { ...previousPage.topic, version: 3 },
				};
				const updated = yield* store.commit(
					nextCommand,
					Effect.gen(function* () {
						yield* store.publish(
							masterId,
							"compat-plan",
							3,
							"Plan after Stable return",
							(value) => ({
								...value,
								artifacts: value.artifacts.map((artifact) => ({
									...artifact,
									version: 3,
								})),
							}),
						);
						return yield* store.publishMemory(
							masterId,
							[
								{
									path: nextPage.topic.path,
									version: 3,
									content: JSON.stringify(nextPage),
								},
							],
							(value) => ({
								...value,
								memory: {
									revision: 3,
									topics: [nextPage.topic],
									consumed: nextPage.topic.sources,
									run: null,
								},
							}),
						);
					}),
				);
				assert.equal(updated.revision, master.revision + 2);
				assert.equal(updated.memory?.revision, 3);
				assert.equal(
					Schema.decodeUnknownSync(Schema.fromJsonString(MasterMemoryPage))(
						(yield* store.artifact(masterId, "memory/testing.md", 3)).content,
					).content,
					"Memory after Stable return",
				);
				assert.equal(
					(yield* store.artifact(masterId, "compat-plan", 3)).content,
					"Plan after Stable return",
				);
				assert.equal(
					(yield* store.reserve(nextCommand, masterId, "compat-return-write"))
						.result?.revision,
					updated.revision,
				);
				assert.equal(
					(yield* store.reserve(commandId, masterId, fingerprint)).result
						?.revision,
					master.revision,
				);
			}
		}),
	);
}
