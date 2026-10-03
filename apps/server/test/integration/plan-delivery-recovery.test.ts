import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentItemId, AgentTurnId, SessionId } from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import type { PersistedMessage } from "../../src/conversation/core/conversation-store-types.ts";
import { makePlanDelivery } from "../../src/conversation/core/plan-delivery.ts";
import type { SessionOperationsOptions } from "../../src/conversation/core/session-operations.ts";
import { createPlanDeliveryJournal } from "../../src/persistence/migrations/0074_plan_deliveries.ts";

it.each([
	false,
	true,
])("restarts with acknowledgement=%s without replaying provider decisions", async (acknowledged) => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-plan-delivery-"));
	const filename = join(directory, "db.sqlite");
	const sessionId = SessionId.make("session"),
		itemId = AgentItemId.make("plan"),
		turnId = AgentTurnId.make("original-turn");
	let runtime = ManagedRuntime.make(sqliteLayer({ filename }));
	const persisted: unknown[] = [];
	const options: Pick<
		SessionOperationsOptions,
		"persistMessage" | "ndjsonAppend"
	> = {
		persistMessage: (_session, content, id, turn) =>
			Effect.sync(() => {
				persisted.push({ content, id, turn });
				return { changed: false } as PersistedMessage;
			}),
		ndjsonAppend: () => Effect.void,
	};
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`CREATE TABLE sessions (id TEXT PRIMARY KEY)`;
				yield* sql`INSERT INTO sessions VALUES (${sessionId})`;
				yield* createPlanDeliveryJournal;
				const journal = makePlanDelivery(sql, options);
				yield* journal.begin(
					sessionId,
					itemId,
					turnId,
					{ providerSessionId: "old-owner" },
					{ outcome: "approved", feedback: "Use the original plan" },
				);
				if (acknowledged) yield* journal.accepted(sessionId, itemId);
			}),
		);
		await runtime.dispose();
		runtime = ManagedRuntime.make(sqliteLayer({ filename }));
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const journal = makePlanDelivery(sql, options);
				yield* journal.recover;
				yield* journal.recover;
				expect((yield* journal.read(sessionId, itemId))?.status).toBe(
					acknowledged ? "committed" : "uncertain",
				);
			}),
		);
		expect(persisted).toHaveLength(acknowledged ? 1 : 0);
		if (acknowledged)
			expect(persisted[0]).toMatchObject({
				turn: turnId,
				content: {
					_tag: "tool_result",
					isError: false,
					output: { outcome: "approved", feedback: "Use the original plan" },
				},
			});
	} finally {
		await runtime.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});
