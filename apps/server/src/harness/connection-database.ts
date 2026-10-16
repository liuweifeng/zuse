import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { CredentialsError } from "../provider/errors.ts";
import type { CredentialsServiceShape } from "../provider/services/credentials-service.ts";
import { openStorage, sealStorage } from "../secure-storage-envelope.ts";

const namespaces = new Set([
	"zuse-chatgpt-connections",
	"zuse-chatgpt-pending-registrations",
	"zuse-supergrok-connections",
	"zuse-supergrok-pending-registrations",
]);
const context = (namespace: string, id: string) =>
	Buffer.from(JSON.stringify(["zuse-model-connection-v1", namespace, id]));
/** Adapt only harness records; all existing provider credentials retain their current storage. */
export const modelConnectionDatabase = (
	legacy: CredentialsServiceShape,
	key: (create?: boolean) => Promise<Buffer>,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const run = <A>(operation: () => Promise<A>) =>
			Effect.tryPromise({
				try: operation,
				catch: () =>
					new CredentialsError({
						providerId: "",
						reason: "Model connection storage is unavailable.",
					}),
			});
		const load = async (
			namespace: string,
			id: string,
		): Promise<string | null> => {
			const rows = await Effect.runPromise(
				sql<{
					envelope: string | null;
				}>`SELECT envelope FROM model_connection_secrets WHERE namespace=${namespace} AND connection_id=${id}`,
			);
			if (rows[0])
				return rows[0].envelope === null
					? null
					: openStorage(
							JSON.parse(rows[0].envelope),
							await key(false),
							context(namespace, id),
						);
			const previous = await Effect.runPromise(
				legacy.getIntegration(namespace, id),
			);
			if (previous === null) return null;
			const envelope = JSON.stringify(
				sealStorage(previous, await key(), context(namespace, id)),
			);

			await Effect.runPromise(
				sql`INSERT INTO model_connection_secrets(namespace,connection_id,envelope,updated_at) VALUES(${namespace},${id},${envelope},${Date.now()}) ON CONFLICT(namespace,connection_id) DO NOTHING`,
			);
			await Effect.runPromise(legacy.removeIntegration(namespace, id));
			return load(namespace, id);
		};
		const store = async (
			namespace: string,
			id: string,
			value: string | null,
		) => {
			const envelope =
				value === null
					? null
					: JSON.stringify(
							sealStorage(value, await key(), context(namespace, id)),
						);
			await Effect.runPromise(
				sql`INSERT INTO model_connection_secrets(namespace,connection_id,envelope,updated_at) VALUES(${namespace},${id},${envelope},${Date.now()}) ON CONFLICT(namespace,connection_id) DO UPDATE SET envelope=excluded.envelope,updated_at=excluded.updated_at`,
			);

			await Effect.runPromise(legacy.removeIntegration(namespace, id));
		};
		return {
			...legacy,
			getIntegration: (namespace, id) =>
				namespaces.has(namespace)
					? run(() => load(namespace, id))
					: legacy.getIntegration(namespace, id),
			setIntegration: (namespace, id, value) =>
				namespaces.has(namespace)
					? run(() => store(namespace, id, value))
					: legacy.setIntegration(namespace, id, value),
			removeIntegration: (namespace, id) =>
				namespaces.has(namespace)
					? run(() => store(namespace, id, null))
					: legacy.removeIntegration(namespace, id),
			listIntegrationAccounts: (namespace) =>
				namespaces.has(namespace)
					? run(async () => {
							const previous = await Effect.runPromise(
								legacy.listIntegrationAccounts(namespace),
							);
							for (const id of previous) await load(namespace, id);
							const rows = await Effect.runPromise(
								sql<{
									connection_id: string;
								}>`SELECT connection_id FROM model_connection_secrets WHERE namespace=${namespace} AND envelope IS NOT NULL ORDER BY connection_id`,
							);
							return rows.map((row) => row.connection_id);
						})
					: legacy.listIntegrationAccounts(namespace),
		} satisfies CredentialsServiceShape;
	});
