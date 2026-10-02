import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";
import type { ChatId, SessionId } from "@zuse/contracts";
import { providerThreadIdFor } from "@zuse/domain/core/state";
import {
	type MessageRow,
	PROVIDER_THREAD_ROW_COLUMNS,
	SESSION_ROW_FROM,
	type SessionRow,
	sessionFromRow,
} from "./conversation-records.ts";

const require = createRequire(import.meta.url);

/** Read only the stopped, retained child copy; never attach it as the live store. */
export const readForkSnapshot = (
	databasePath: string,
	chatId: ChatId,
	sessionId: SessionId,
) => {
	const { DatabaseSync } = require("node:sqlite") as typeof NodeSqlite;
	const db = new DatabaseSync(databasePath, { readOnly: true });
	try {
		const hasThreads =
			db
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_provider_threads'",
				)
				.get() !== undefined;
		const row = db
			.prepare(
				hasThreads
					? `SELECT s.*, ${PROVIDER_THREAD_ROW_COLUMNS} ${SESSION_ROW_FROM} WHERE s.id = ? AND s.chat_id = ?`
					: "SELECT * FROM sessions WHERE id = ? AND chat_id = ?",
			)
			.get(sessionId, chatId);
		if (row === undefined)
			throw new Error("Machine fork source session is missing");
		// Retained machine snapshots can predate the engine migration. Normalize
		// their native handle in memory; the retained database remains read-only.
		const normalized =
			!hasThreads &&
			typeof row.cursor === "string" &&
			row.resume_strategy !== "none"
				? {
						...row,
						pt_id: providerThreadIdFor(
							String(row.id),
							String(row.provider_id),
							row.cursor,
						),
						pt_provider: row.provider_id,
						pt_native_thread_id: row.cursor,
						pt_native_head_id: row.provider_event_cursor ?? null,
						pt_status: "idle",
						pt_first_turn_ordinal: null,
						pt_last_turn_ordinal: null,
						pt_created_at: row.created_at,
						pt_updated_at: row.updated_at,
					}
				: row;
		const source = sessionFromRow(normalized as unknown as SessionRow);
		const rows = db
			.prepare(
				"SELECT id, session_id, role, kind, content_json, parent_item_id, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC, sequence ASC",
			)
			.all(sessionId) as unknown as MessageRow[];
		return { source, rows };
	} finally {
		db.close();
	}
};
