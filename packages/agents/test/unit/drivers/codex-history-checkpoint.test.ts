import { expect, it } from "vitest";
import { makeCodexHistoryCheckpoints } from "../../../src/drivers/codex-history-checkpoint.ts";

it("verifies a native prefix after a lost rollback reply and never drops another turn on retry", async () => {
	let ids = ["one", "two", "three"];
	const calls: number[] = [];
	const history = makeCodexHistoryCheckpoints({
		read: async (id) => ({
			id,
			turns: ids.map((id) => ({ id })),
			status: { type: "idle" },
		}),
		rollback: async (_id, count) => {
			calls.push(count);
			ids = ids.slice(0, -count);
			throw new Error("lost reply");
		},
	});
	const target = {
		providerId: "codex",
		nativeThreadId: "thread",
		turnIds: ["one"],
	};
	expect(await history.restore(target)).toBe(true);
	expect(await history.restore(target)).toBe(true);
	expect(calls).toEqual([2]);
	expect(await history.capture("thread")).toEqual(target);
});

it("refuses divergent, shortened, active, or foreign provider histories", async () => {
	let ids = ["one", "different"];
	let status = "idle";
	let calls = 0;
	const history = makeCodexHistoryCheckpoints({
		read: async (id) => ({
			id,
			turns: ids.map((id) => ({ id })),
			status: { type: status },
		}),
		rollback: async () => {
			calls++;
		},
	});
	const target = {
		providerId: "codex",
		nativeThreadId: "thread",
		turnIds: ["one", "two"],
	};
	expect(await history.restore(target)).toBe(false);
	ids = ["one"];
	expect(await history.restore(target)).toBe(false);
	ids = ["one", "two", "three"];
	status = "active";
	expect(await history.restore(target)).toBe(false);
	expect(await history.capture("thread")).toBe(null);
	status = "idle";
	expect(await history.restore({ ...target, providerId: "other" })).toBe(false);
	expect(calls).toBe(0);
});

it("never reports success when rollback failed or returned an unverified boundary", async () => {
	const history = makeCodexHistoryCheckpoints({
		read: async (id) => ({
			id,
			turns: [{ id: "one" }, { id: "two" }],
			status: { type: "idle" },
		}),
		rollback: async () => {
			throw new Error("failed");
		},
	});
	expect(
		await history.restore({
			providerId: "codex",
			nativeThreadId: "thread",
			turnIds: ["one"],
		}),
	).toBe(false);
});
