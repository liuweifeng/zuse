import { readFile } from "node:fs/promises";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { Client, Pool } from "pg";
import { expect, it } from "vitest";
import { CloudWorkspaceStoreMemory } from "../../src/cloud-workspace-store.ts";
import * as Config from "../../src/config.ts";
import { routeModelConnectionRequest } from "../../src/model-connection-routes.ts";
import {
	ModelConnectionStore,
	ModelConnectionStoreLive,
} from "../../src/model-connection-store.ts";
import { ApiStoreMemory } from "../../src/store.ts";
import { WorkosVerifierTest } from "../../src/workos.ts";

const connectionString = process.env.ZUSE_TEST_DATABASE_URL;
it.skipIf(!connectionString)(
	"encrypts shared secrets, isolates accounts, fences stale refreshes, and survives restart",
	async () => {
		const db = new Client({ connectionString });
		await db.connect();
		const schema = `connections_${crypto.randomUUID().replaceAll("-", "")}`;
		await db.query(`CREATE SCHEMA ${schema}`);
		await db.query(`SET search_path=${schema}`);
		await db.query(
			await readFile(
				new URL(
					"../../drizzle/migrations/0029_model_connections.sql",
					import.meta.url,
				),
				"utf8",
			),
		);
		const sql = PgClient.layerFrom(
			PgClient.fromPool({
				acquire: Effect.acquireRelease(
					Effect.sync(
						() =>
							new Pool({
								connectionString,
								options: `-c search_path=${schema}`,
							}),
					),
					(pool) => Effect.promise(() => pool.end()),
				),
			}),
		);
		const config = Config.layer({
			apiIssuer: "https://api.test",
			workosJwksUrl: "https://unused.test",
			workosIssuer: "https://unused.test",
			mintPrivateKey: Redacted.make("{}"),
			mintPublicKey: "{}",
			cloudDataEncryptionKey: Redacted.make(
				"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			),
		});
		const layers = Layer.mergeAll(
			ModelConnectionStoreLive.pipe(Layer.provide(Layer.merge(sql, config))),
			WorkosVerifierTest,
			ApiStoreMemory,
			CloudWorkspaceStoreMemory,
		);
		let runtime = ManagedRuntime.make(layers);
		try {
			let store = await runtime.runPromise(ModelConnectionStore);
			expect(await store.acquire("a", "supergrok", "owner")).toBe(true);
			expect(await store.acquire("a", "supergrok", "other")).toBe(false);
			await store.write(
				"a",
				"supergrok",
				"owner",
				"active",
				"one",
				JSON.stringify({
					accessToken: "secret-access",
					refreshToken: "secret-refresh",
				}),
			);
			const rows = await db.query("SELECT envelope FROM api_model_connections");
			expect(JSON.stringify(rows.rows)).not.toMatch(
				/secret-access|secret-refresh/,
			);
			await store.acquire("b", "supergrok", "owner");
			expect(
				await store.read("b", "supergrok", "owner", "active", "one"),
			).toBeNull();
			await db.query(
				"UPDATE api_model_connection_leases SET expires_at_ms=0 WHERE account_id='a'",
			);
			expect(await store.acquire("a", "supergrok", "new-owner")).toBe(true);
			await expect(
				store.write("a", "supergrok", "owner", "active", "one", "stale"),
			).rejects.toThrow();
			await store.release("a", "supergrok", "owner");
			expect(
				await store.read("a", "supergrok", "new-owner", "active", "one"),
			).toContain("secret-refresh");
			await db.query(
				"INSERT INTO api_model_connections SELECT 'b',provider,kind,connection_id,envelope FROM api_model_connections WHERE account_id='a'",
			);
			await expect(
				store.read("b", "supergrok", "owner", "active", "one"),
			).rejects.toThrow();
			await store.release("a", "supergrok", "new-owner");
			await runtime.dispose();
			runtime = ManagedRuntime.make(layers);
			store = await runtime.runPromise(ModelConnectionStore);
			expect(await store.acquire("a", "supergrok", "restart")).toBe(true);
			expect(
				await store.read("a", "supergrok", "restart", "active", "one"),
			).toContain("secret-access");
			const deniedHeaders: HeadersInit[] = [
				{ origin: "https://code.zuse.sh" },
				{},
			];
			for (const headers of deniedHeaders) {
				const denied = await runtime.runPromise(
					Effect.result(
						routeModelConnectionRequest(
							new Request("https://api.test/v1/model-connections/storage", {
								method: "POST",
								headers,
								body: "{}",
							}),
						),
					),
				);
				expect(denied._tag).toBe("Failure");
			}
			const reply = await runtime.runPromise(
				routeModelConnectionRequest(
					new Request("https://api.test/v1/model-connections/storage", {
						method: "POST",
						headers: { authorization: "Bearer test-token:a" },
						body: JSON.stringify({
							provider: "supergrok",
							action: "acquire",
							token: "http-test-token-1234",
							accountId: "attacker",
						}),
					}),
				),
			);
			expect(reply?.headers.get("cache-control")).toBe("no-store");
			expect(await reply?.json()).toEqual({ value: false });

			const other = await runtime.runPromise(
				routeModelConnectionRequest(
					new Request("https://api.test/v1/model-connections/storage", {
						method: "POST",
						headers: { authorization: "Bearer test-token:c" },
						body: JSON.stringify({
							provider: "supergrok",
							action: "acquire",
							token: "http-test-token-1234",
							accountId: "a",
						}),
					}),
				),
			);
			expect(await other?.json()).toEqual({ value: true });
			expect(
				(
					await db.query(
						"SELECT account_id FROM api_model_connection_leases WHERE token='http-test-token-1234'",
					)
				).rows,
			).toEqual([{ account_id: "c" }]);
			await store.removeAccount("a");
			expect(
				(
					await db.query(
						"SELECT * FROM api_model_connections WHERE account_id='a'",
					)
				).rows,
			).toHaveLength(0);
		} finally {
			await runtime.dispose();
			await db.query(`DROP SCHEMA ${schema} CASCADE`);
			await db.end();
		}
	},
	30000,
);
