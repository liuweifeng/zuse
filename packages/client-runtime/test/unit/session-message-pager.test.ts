import {
	EnvironmentId,
	QueueState,
	SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { expect, it, vi } from "vitest";
import type { ClientBus } from "../../src/client-bus";
import type { ResourceView } from "../../src/resource-state";
import { makeSessionMessagePager } from "../../src/session-message-pager";

const harness = () => {
	let view: ResourceView<SessionTimelineProjection> = {
		data: SessionTimelineProjection.make({
			messages: [],
			olderMessageSequence: 100,
			status: "idle",
			activeTurn: null,
			turnCount: 0,
			queue: QueueState.make({ items: [], paused: false }),
			permissionMode: "default",
			runtimeMode: "approval-required",
		}),
		origin: "runtime",
		connection: "connected",
		sync: "live",
		generation: 1,
		cursor: { epoch: "first", version: 1 },
		pendingCommands: [],
		failedCommands: [],
	};
	const bus = {
		snapshot: () => view,
		client: () => null,
	} as unknown as ClientBus<unknown>;
	const pending: Array<(page: null) => void> = [];
	const readPage = vi.fn(
		() => new Promise<null>((resolve) => pending.push(resolve)),
	);
	const pager = makeSessionMessagePager({ getBus: () => bus, readPage });
	return {
		ref: {
			environmentId: EnvironmentId.make("cloud"),
			sessionId: SessionId.make("session"),
		},
		pager,
		readPage,
		refresh: (change: Partial<typeof view>) => {
			view = { ...view, ...change };
		},
		complete: () => {
			if (view.data !== null)
				view = {
					...view,
					data: SessionTimelineProjection.make({
						...view.data,
						olderMessageSequence: null,
					}),
				};
		},
		finish: (index?: number) => {
			if (index === undefined) for (const resolve of pending) resolve(null);
			else pending[index]?.(null);
		},
	};
};

it("shares a pending page across callers in the same resource lifetime", async () => {
	const h = harness();
	const first = h.pager.load(h.ref);
	h.refresh({ cursor: { epoch: "first", version: 2 } });
	const second = h.pager.load(h.ref);
	expect(second).toBe(first);
	expect(h.readPage).toHaveBeenCalledTimes(1);
	h.finish();
	await first;
});

it.each([
	"abort",
	"generation",
	"epoch",
] as const)("does not share an obsolete pending page after %s", async (changed) => {
	const h = harness();
	const controller = new AbortController();
	const first = h.pager.load(h.ref, controller.signal);
	if (changed === "abort") controller.abort();
	else if (changed === "generation") h.refresh({ generation: 2 });
	else h.refresh({ cursor: { epoch: "second", version: 1 } });
	const second = h.pager.load(h.ref);
	expect(second).not.toBe(first);
	expect(h.readPage).toHaveBeenCalledTimes(2);
	h.finish();
	await Promise.all([first, second]);
});

it("does not let an obsolete request remove its replacement from deduplication", async () => {
	const h = harness();
	const controller = new AbortController();
	const first = h.pager.load(h.ref, controller.signal);
	controller.abort();
	const second = h.pager.load(h.ref);
	h.finish(0);
	await first;
	expect(h.pager.load(h.ref)).toBe(second);
	h.finish(1);
	await second;
});

it("uses the completed timeline instead of a pending obsolete page", async () => {
	const h = harness();
	const first = h.pager.load(h.ref);
	h.complete();
	await expect(h.pager.load(h.ref)).resolves.toEqual({
		applied: false,
		loaded: 0,
		hasMore: false,
	});
	expect(h.readPage).toHaveBeenCalledTimes(1);
	h.finish();
	await first;
});
