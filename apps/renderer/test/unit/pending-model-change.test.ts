import type { ResourceView } from "@zuse/client-runtime/resource-state";
import {
	ComposerInput,
	EnvironmentId,
	QueuedMessage,
	SessionId,
	type SessionTimelineProjection,
} from "@zuse/contracts";
import { emptyTimelineProjection } from "@zuse/domain/projectors/timeline-reducer";
import { describe, expect, it, vi } from "vitest";
import {
	createPendingModelChanges,
	type ModelSelection,
} from "../../src/lib/pending-model-change.ts";

const ref = {
	environmentId: EnvironmentId.make("local"),
	sessionId: SessionId.make("chat"),
};
const current: ModelSelection = { providerId: "codex", model: "old" };
const target: ModelSelection = { providerId: "claude", model: "new" };
const busyError = {
	_tag: "SessionConfigurationError",
	reason:
		"Finish or stop the active turn and clear queued messages before switching provider or model.",
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture() {
	let view: ResourceView<SessionTimelineProjection> = {
		data: emptyTimelineProjection(),
		origin: "runtime",
		connection: "connected",
		sync: "live",
		generation: 1,
		cursor: { epoch: "one", version: 1 },
		pendingCommands: [],
		failedCommands: [],
	};
	let listener = () => {};
	const stop = vi.fn();
	const apply = vi.fn(
		async (_ref: typeof ref, _selection: ModelSelection) => {},
	);
	const changed = vi.fn();
	const failed = vi.fn(() => "real failure");
	const coordinator = createPendingModelChanges({
		current: () => current,
		snapshot: () => view,
		retain: (_ref, update) => {
			listener = update;
			return stop;
		},
		apply,
		changed,
		failed,
	});
	return {
		coordinator,
		apply,
		changed,
		failed,
		stop,
		update(patch: Partial<ResourceView<SessionTimelineProjection>>) {
			view = { ...view, ...patch };
			listener();
		},
		work(active: boolean, queued = false) {
			// Only the presence of the canonical turn/queue matters to configuration.
			view = {
				...view,
				cursor: { epoch: "one", version: (view.cursor?.version ?? 0) + 1 },
				data: {
					...emptyTimelineProjection(),
					activeTurn: active
						? ({ id: "turn" } as SessionTimelineProjection["activeTurn"])
						: null,
					queue: {
						items: queued
							? [
									QueuedMessage.make({
										id: "queued",
										sessionId: ref.sessionId,
										input: ComposerInput.make({
											text: "later",
											attachments: [],
											fileRefs: [],
											skillRefs: [],
											annotations: [],
										}),
										position: 0,
										createdAt: new Date(1),
										updatedAt: new Date(1),
									}),
								]
							: [],
						paused: queued,
					},
				},
			};
			listener();
		},
	};
}
describe("model selections during active work", () => {
	it("defers while a turn exists even if the status says idle; applies once settled", async () => {
		const f = fixture();
		f.work(true);
		expect(await f.coordinator.request(ref, target)).toEqual({ ok: true });
		expect(f.apply).not.toHaveBeenCalled();
		f.work(false);
		await tick();
		expect(f.apply).toHaveBeenCalledExactlyOnceWith(ref, target);
		expect(f.stop).toHaveBeenCalledOnce();
		expect(f.changed).toHaveBeenLastCalledWith(ref, null);
	});
	it("waits for paused queued messages without mutating or sending them", async () => {
		const f = fixture();
		f.work(false, true);
		await f.coordinator.request(ref, target);
		expect(f.apply).not.toHaveBeenCalled();
		f.work(false);
		await tick();
		expect(f.apply).toHaveBeenCalledOnce();
	});
	it("keeps only the newest selection and cancels by choosing the current model", async () => {
		const f = fixture();
		f.work(true);
		await f.coordinator.request(ref, target);
		await f.coordinator.request(ref, { providerId: "codex", model: "latest" });
		f.work(false);
		await tick();
		expect(f.apply).toHaveBeenCalledExactlyOnceWith(ref, {
			providerId: "codex",
			model: "latest",
		});
		f.work(true);
		await f.coordinator.request(ref, target);
		await f.coordinator.request(ref, current);
		f.work(false);
		await tick();
		expect(f.apply).toHaveBeenCalledOnce();
		expect(f.stop).toHaveBeenCalledTimes(2);
	});
	it("does not apply from cached disconnected state", async () => {
		const f = fixture();
		f.update({ connection: "reconnecting", sync: "stale" });
		await f.coordinator.request(ref, target);
		expect(f.apply).not.toHaveBeenCalled();
		f.update({ connection: "connected", sync: "live" });
		await tick();
		expect(f.apply).toHaveBeenCalledOnce();
	});
	it("surfaces genuine failures and releases the subscription without replay", async () => {
		const f = fixture();
		f.apply.mockRejectedValueOnce(new Error("provider missing"));
		expect(await f.coordinator.request(ref, target)).toEqual({
			ok: false,
			reason: "real failure",
		});
		f.work(false);
		await tick();
		expect(f.apply).toHaveBeenCalledOnce();
		expect(f.failed).toHaveBeenCalledOnce();
		expect(f.stop).toHaveBeenCalledOnce();
	});
	it("defers only the known busy rejection, then retries after a newer settled timeline", async () => {
		const f = fixture();
		f.apply.mockRejectedValueOnce(busyError);
		expect(await f.coordinator.request(ref, target)).toEqual({ ok: true });
		await tick();
		expect(f.apply).toHaveBeenCalledOnce();
		f.work(false);
		await tick();
		expect(f.apply).toHaveBeenCalledTimes(2);
		expect(f.failed).not.toHaveBeenCalled();
	});
	it("handles work settling while the rejected RPC is still in flight", async () => {
		const f = fixture();
		let reject!: (cause: unknown) => void;
		f.apply.mockImplementationOnce(
			() =>
				new Promise((_resolve, fail) => {
					reject = fail;
				}),
		);
		const requested = f.coordinator.request(ref, target);
		f.work(true);
		f.work(false);
		reject(busyError);
		await requested;
		await tick();
		expect(f.apply).toHaveBeenCalledTimes(2);
		expect(f.stop).toHaveBeenCalledOnce();
	});
	it("releases retained sessions when disposed", async () => {
		const f = fixture();
		f.work(true);
		await f.coordinator.request(ref, target);
		f.coordinator.dispose();
		f.work(false);
		await tick();
		expect(f.stop).toHaveBeenCalledOnce();
		expect(f.apply).not.toHaveBeenCalled();
	});
	it("releases pending state when retaining the timeline fails", async () => {
		const changed = vi.fn();
		const coordinator = createPendingModelChanges({
			current: () => current,
			snapshot: () => {
				throw new Error("unavailable");
			},
			retain: () => {
				throw new Error("disconnected");
			},
			apply: vi.fn(),
			changed,
			failed: () => "disconnected",
		});
		expect(await coordinator.request(ref, target)).toEqual({
			ok: false,
			reason: "disconnected",
		});
		expect(changed).toHaveBeenLastCalledWith(ref, null);
	});
	it("releases the lease if reading the retained snapshot fails", async () => {
		const stop = vi.fn();
		const coordinator = createPendingModelChanges({
			current: () => current,
			snapshot: () => {
				throw new Error("unavailable");
			},
			retain: () => stop,
			apply: vi.fn(),
			changed: vi.fn(),
			failed: () => "unavailable",
		});
		expect(await coordinator.request(ref, target)).toEqual({
			ok: false,
			reason: "unavailable",
		});
		expect(stop).toHaveBeenCalledOnce();
	});
	it("preserves an updated choice made during an in-flight configuration", async () => {
		const f = fixture();
		let resolve!: () => void;
		f.apply.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const requested = f.coordinator.request(ref, target);
		await f.coordinator.request(ref, current);
		resolve();
		await requested;
		await tick();
		expect(f.apply.mock.calls.map((call) => call[1])).toEqual([
			target,
			current,
		]);
		expect(f.stop).toHaveBeenCalledOnce();
	});
});
