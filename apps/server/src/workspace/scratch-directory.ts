import { createHash } from "node:crypto";
import { join } from "node:path";

export const projectlessThreadsRoot = (homeDir: string): string =>
	join(homeDir, ".zuse", "threads");

/** Folder names contain no prompt text; saved paths survive renames and restarts. */
export const scratchDirectoryName = (id: string, now: Date): string => {
	const shortId = createHash("sha256").update(id).digest("hex").slice(0, 12);
	return `${now.toISOString().slice(0, 10)}-${shortId}`;
};
