import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface SqliteProcessLock {
	readonly release: () => void;
}

/**
 * A nonblocking, OS-backed process lock. Use a dedicated file and never unlink
 * it: replacing its inode would allow two owners. SQLite releases ownership on
 * connection close or process death; a suspended process retains ownership.
 * The parent directory must already exist. Contention returns null; IO errors
 * propagate so callers cannot mistake an inaccessible lock for an idle owner.
 */
export const tryAcquireProcessLock = (
	filename: string,
): SqliteProcessLock | null => {
	const database = new DatabaseSync(filename);
	try {
		chmodSync(filename, 0o600);
		database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
	} catch (cause) {
		database.close();
		if (
			typeof cause === "object" &&
			cause !== null &&
			"errcode" in cause &&
			typeof cause.errcode === "number" &&
			(cause.errcode & 255) === 5
		)
			return null;
		throw cause;
	}
	let released = false;
	return {
		release: () => {
			if (released) return;
			database.close();
			released = true;
		},
	};
};
