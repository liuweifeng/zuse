import type { NativeHistoryCheckpoint } from "@zuse/contracts";

interface NativeThread {
	readonly id: string;
	readonly turns: ReadonlyArray<{ readonly id: string }>;
	readonly status: { readonly type: string };
}
export interface CodexHistoryTransport {
	readonly read: (threadId: string) => Promise<NativeThread>;
	readonly rollback: (threadId: string, numTurns: number) => Promise<unknown>;
}
const idle = (thread: NativeThread) =>
	thread.status.type === "idle" || thread.status.type === "notLoaded";
const prefix = (
	current: ReadonlyArray<string>,
	target: ReadonlyArray<string>,
) =>
	target.length <= current.length &&
	target.every((id, index) => current[index] === id);

/** Re-read after every uncertain mutation. A retry never blindly drops another turn. */
export const makeCodexHistoryCheckpoints = (
	transport: CodexHistoryTransport,
) => ({
	capture: async (
		threadId: string,
	): Promise<NativeHistoryCheckpoint | null> => {
		const thread = await transport.read(threadId);
		if (thread.id !== threadId || !idle(thread)) return null;
		return {
			providerId: "codex",
			nativeThreadId: threadId,
			turnIds: thread.turns.map((turn) => turn.id),
		};
	},
	restore: async (checkpoint: NativeHistoryCheckpoint): Promise<boolean> => {
		if (checkpoint.providerId !== "codex") return false;
		const before = await transport.read(checkpoint.nativeThreadId);
		const ids = before.turns.map((turn) => turn.id);
		if (
			before.id !== checkpoint.nativeThreadId ||
			!idle(before) ||
			!prefix(ids, checkpoint.turnIds)
		)
			return false;
		const count = ids.length - checkpoint.turnIds.length;
		if (count > 0) {
			try {
				await transport.rollback(checkpoint.nativeThreadId, count);
			} catch {}
		}
		const after = await transport.read(checkpoint.nativeThreadId);
		const actual = after.turns.map((turn) => turn.id);
		return (
			after.id === checkpoint.nativeThreadId &&
			idle(after) &&
			actual.length === checkpoint.turnIds.length &&
			prefix(actual, checkpoint.turnIds)
		);
	},
});
