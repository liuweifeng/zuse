import {
	AgentTurnId,
	AttemptId,
	type SessionAttemptHistoryPage,
	type SessionAttemptSummary,
} from "@zuse/contracts";
import { expect, it, vi } from "vitest";
import { createSessionAttemptHistory } from "../../src/session-attempt-history.ts";

const row = (turn: number, attempt = 1): SessionAttemptSummary => ({
	id: AttemptId.make(`${turn}:${attempt}`),
	turnId: AgentTurnId.make(`turn:${turn}`),
	turnOrdinal: turn,
	ordinal: attempt,
	reason: "initial",
	status: "completed",
	startedAt: 1,
	completedAt: 2,
	rolledBack: false,
});
const pending = () => {
	let resolve!: (page: SessionAttemptHistoryPage) => void;
	const promise = new Promise<SessionAttemptHistoryPage>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
};

it("coalesces older pages and fences a late page after refresh", async () => {
	const older = pending();
	const fetch = vi
		.fn()
		.mockResolvedValueOnce({
			items: [row(3)],
			nextCursor: { turnOrdinal: 3, attemptOrdinal: 1 },
		})
		.mockReturnValueOnce(older.promise)
		.mockResolvedValueOnce({ items: [row(4)], nextCursor: null });
	const history = createSessionAttemptHistory(fetch);
	await history.refresh();
	const first = history.more();
	expect(history.more()).toBe(first);
	await Promise.resolve();
	await history.refresh();
	older.resolve({ items: [row(2)], nextCursor: null });
	await first;
	expect(history.snapshot().items).toEqual([row(4)]);
	expect(fetch.mock.calls[1]).toEqual([{ turnOrdinal: 3, attemptOrdinal: 1 }]);
});
it("deduplicates IDs, retains data on failure, and retries the same page", async () => {
	const cursor = { turnOrdinal: 2, attemptOrdinal: 1 };
	const fetch = vi
		.fn()
		.mockResolvedValueOnce({ items: [row(2)], nextCursor: cursor })
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValueOnce({ items: [row(2), row(1)], nextCursor: cursor });
	const history = createSessionAttemptHistory(fetch);
	await history.refresh();
	await history.more();
	expect(history.snapshot().items).toEqual([row(2)]);
	expect(history.snapshot().error).toBeInstanceOf(Error);
	await history.more();
	expect(history.snapshot().items).toEqual([row(2), row(1)]);
	expect(history.snapshot().nextCursor).toBe(null);
	expect(fetch.mock.calls.slice(1)).toEqual([[cursor], [cursor]]);
});
it("ignores unmounted responses and can refresh after a lifecycle replay", async () => {
	const late = pending();
	const fetch = vi
		.fn()
		.mockReturnValueOnce(late.promise)
		.mockResolvedValueOnce({ items: [row(1)], nextCursor: null });
	const history = createSessionAttemptHistory(fetch);
	const load = history.refresh();
	await Promise.resolve();
	history.cancel();
	late.resolve({ items: [row(2)], nextCursor: null });
	await load;
	expect(history.snapshot().items).toEqual([]);
	await history.refresh();
	expect(history.snapshot().items).toEqual([row(1)]);
});
