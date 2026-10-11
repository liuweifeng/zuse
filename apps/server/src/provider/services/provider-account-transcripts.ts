import { copyFile, cp, mkdir, readdir, rename, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { NativeAccountProvider } from "@zuse/contracts";

const SAFE_CURSOR = /^[A-Za-z0-9_-]+$/;
const CODEX_ROLLOUT_ROOTS = ["sessions", "archived_sessions"] as const;
// Codex shards rollouts by date: sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl.
const CODEX_MAX_DEPTH = 4;

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

const directories = async (path: string) =>
	(await readdir(path, { withFileTypes: true }).catch(() => [])).filter(
		(entry) => entry.isDirectory(),
	);

/** Claude keeps `<config>/projects/<cwd-slug>/<session>.jsonl`; the slug is not recomputed. */
const findClaudeTranscript = async (home: string, cursor: string) => {
	const projects = join(home, "projects");
	for (const project of await directories(projects)) {
		const path = join(projects, project.name, `${cursor}.jsonl`);
		if (await exists(path)) return path;
	}
	return null;
};

const findCodexRollout = async (home: string, cursor: string) => {
	const suffix = `-${cursor}.jsonl`;
	const walk = async (path: string, depth: number): Promise<string | null> => {
		const entries = await readdir(path, { withFileTypes: true }).catch(
			() => [],
		);
		const match = entries.find(
			(entry) => entry.isFile() && entry.name.endsWith(suffix),
		);
		if (match) return join(path, match.name);
		if (depth === 0) return null;
		// Newest shards first: an active thread is almost always recent.
		const children = entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort()
			.reverse();
		for (const child of children) {
			const found = await walk(join(path, child), depth - 1);
			if (found) return found;
		}
		return null;
	};
	for (const root of CODEX_ROLLOUT_ROOTS) {
		const found = await walk(join(home, root), CODEX_MAX_DEPTH);
		if (found) return found;
	}
	return null;
};

const copyAtomically = async (source: string, target: string) => {
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	const staging = `${target}.zuse-${process.pid}-${Date.now()}`;
	await copyFile(source, staging);
	await rename(staging, target);
};

/**
 * Copy one chat's native transcript between account homes so the provider can
 * resume it under the other login. The source is authoritative: it is where
 * the chat last ran, so an older copy in the target (from switching back and
 * forth) is replaced. Returns false when the source has no transcript.
 */
export const copyProviderTranscript = async (
	provider: NativeAccountProvider,
	sourceHome: string,
	targetHome: string,
	cursor: string,
): Promise<boolean> => {
	if (!SAFE_CURSOR.test(cursor)) return false;
	if (sourceHome === targetHome) return true;
	const source =
		provider === "claude"
			? await findClaudeTranscript(sourceHome, cursor)
			: await findCodexRollout(sourceHome, cursor);
	if (source === null) return false;
	const target = join(targetHome, relative(sourceHome, source));
	await copyAtomically(source, target);
	if (provider === "claude") {
		// Subagent transcripts and spilled tool results live beside the session.
		const sidecar = join(dirname(source), cursor);
		if (await exists(sidecar))
			await cp(sidecar, join(dirname(target), cursor), {
				recursive: true,
				force: true,
			});
	}
	return true;
};
