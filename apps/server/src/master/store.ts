import { Master, MasterError } from "@zuse/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const masterFailure = (cause: unknown): MasterError =>
	cause instanceof MasterError
		? cause
		: new MasterError({
				reason:
					typeof cause === "object" &&
					cause !== null &&
					"reason" in cause &&
					typeof cause.reason === "string"
						? cause.reason
						: cause instanceof Error
							? cause.message
							: String(cause),
			});
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Master));

export const makeMasterStore = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const get = (id: string) =>
		Effect.gen(function* () {
			const rows = yield* sql<{
				state_json: string;
			}>`SELECT state_json FROM masters WHERE id = ${id}`;
			if (!rows[0])
				return yield* Effect.fail(
					new MasterError({ reason: "Zot not found." }),
				);
			return yield* decode(rows[0].state_json);
		}).pipe(Effect.mapError(masterFailure));
	const save = (master: Master, expectedRevision: number | null) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const json = JSON.stringify(master);
					if (expectedRevision === null) {
						yield* sql`INSERT INTO masters (id, revision, state_json) VALUES (${master.id}, ${master.revision}, ${json})`;
					} else {
						const changed =
							yield* sql`UPDATE masters SET revision = ${master.revision}, state_json = ${json} WHERE id = ${master.id} AND revision = ${expectedRevision} RETURNING id`;
						if (changed.length !== 1)
							return yield* Effect.fail(
								new MasterError({
									reason: "The Zot changed. Refresh before trying again.",
								}),
							);
					}
					yield* sql`DELETE FROM master_repositories WHERE master_id = ${master.id}`;
					for (const repository of master.repositories) {
						const owner =
							yield* sql`SELECT master_id FROM master_repositories WHERE environment_id = ${repository.environmentId} AND folder_id = ${repository.folderId}`;
						if (owner.length)
							return yield* Effect.fail(
								new MasterError({
									reason: `${repository.name} already belongs to another Zot.`,
								}),
							);
						yield* sql`INSERT INTO master_repositories VALUES (${repository.environmentId}, ${repository.folderId}, ${master.id})`;
					}
					yield* sql`INSERT INTO master_revisions VALUES (${master.id}, ${master.revision}, ${json})`;
					return master;
				}),
			)
			.pipe(Effect.mapError(masterFailure));
	const change = (id: string, update: (master: Master) => Master) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const previous = yield* get(id);
					const next = yield* Effect.try({
						try: () => update(previous),
						catch: masterFailure,
					});
					return yield* save(
						{ ...next, revision: previous.revision + 1, updatedAt: Date.now() },
						previous.revision,
					);
				}),
			)
			.pipe(Effect.mapError(masterFailure));
	const complete = (commandId: string, master: Master) =>
		sql`UPDATE master_commands SET result_json = ${JSON.stringify(master)}, phase = 'done' WHERE command_id = ${commandId}`.pipe(
			Effect.asVoid,
			Effect.mapError(masterFailure),
		);
	const commit = <E>(commandId: string, operation: Effect.Effect<Master, E>) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const result = yield* operation;
					yield* complete(commandId, result);
					return result;
				}),
			)
			.pipe(Effect.mapError(masterFailure));
	return {
		get,
		save,
		change,
		list: () =>
			Effect.gen(function* () {
				const rows = yield* sql<{
					state_json: string;
				}>`SELECT state_json FROM masters ORDER BY id`;
				return yield* Effect.forEach(rows, (row) => decode(row.state_json));
			}).pipe(Effect.mapError(masterFailure)),
		artifact: (masterId: string, artifactId: string, version: number) =>
			Effect.gen(function* () {
				const rows = yield* sql<{
					content: string;
				}>`SELECT content FROM master_artifacts WHERE master_id = ${masterId} AND artifact_id = ${artifactId} AND version = ${version}`;
				if (!rows[0])
					return yield* Effect.fail(
						new MasterError({ reason: "Artifact version not found." }),
					);
				return rows[0];
			}).pipe(Effect.mapError(masterFailure)),
		publish: (
			masterId: string,
			artifactId: string,
			version: number,
			content: string,
			update: (master: Master) => Master,
		) =>
			sql
				.withTransaction(
					Effect.gen(function* () {
						yield* sql`INSERT INTO master_artifacts VALUES (${masterId}, ${artifactId}, ${version}, ${content})`;
						return yield* change(masterId, update);
					}),
				)
				.pipe(Effect.mapError(masterFailure)),
		publishMemory: (
			masterId: string,
			pages: readonly { path: string; version: number; content: string }[],
			update: (master: Master) => Master,
		) =>
			sql
				.withTransaction(
					Effect.gen(function* () {
						for (const page of pages)
							yield* sql`INSERT INTO master_artifacts VALUES (${masterId}, ${`memory/${page.path}`}, ${page.version}, ${page.content})`;
						return yield* change(masterId, update);
					}),
				)
				.pipe(Effect.mapError(masterFailure)),
		reserve: (
			commandId: string,
			masterId: string,
			fingerprint: string,
			inputJson: string | null = null,
		) =>
			sql
				.withTransaction(
					Effect.gen(function* () {
						yield* sql`INSERT OR IGNORE INTO master_commands (command_id, master_id, fingerprint, created_at, input_json) VALUES (${commandId}, ${masterId}, ${fingerprint}, ${Date.now()}, ${inputJson})`;
						const rows = yield* sql<{
							fingerprint: string;
							result_json: string | null;
							phase: string;
						}>`SELECT fingerprint, result_json, phase FROM master_commands WHERE command_id = ${commandId}`;
						const row = rows[0];
						if (!row || row.fingerprint !== fingerprint)
							return yield* Effect.fail(
								new MasterError({
									reason: "Command identity was reused with different input.",
								}),
							);
						return {
							result:
								row.result_json === null
									? null
									: yield* decode(row.result_json),
							phase: row.phase,
						};
					}),
				)
				.pipe(Effect.mapError(masterFailure)),
		phase: (commandId: string, phase: string) =>
			sql`UPDATE master_commands SET phase = ${phase} WHERE command_id = ${commandId}`.pipe(
				Effect.asVoid,
				Effect.mapError(masterFailure),
			),
		complete,
		commit,
	};
});

export class MasterStore extends Context.Service<
	MasterStore,
	Effect.Success<typeof makeMasterStore>
>()("zuse/MasterStore") {}
export const MasterStoreLive = Layer.effect(MasterStore, makeMasterStore);
