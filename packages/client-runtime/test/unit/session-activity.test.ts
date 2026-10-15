import {
	AgentItemId,
	EnvironmentId,
	PermissionRequest,
	QueueState,
	SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ClientBus, type ResourceDriverContext } from "../../src/client-bus.ts";
import { makeResourceKey } from "../../src/resource-ref.ts";
import { retainSessionActivity } from "../../src/session-activity.ts";
import {
	deriveSessionPresentation,
	type SessionRuntimeState,
} from "../../src/session-presentation.ts";

const ref = {
	environmentId: EnvironmentId.make("activity-env"),
	sessionId: SessionId.make("activity-chat"),
};
const key = makeResourceKey<SessionTimelineProjection>("session-timeline", ref);
const projection = (
	status: "running" | "idle",
	interactions: SessionTimelineProjection["interactions"] = [],
) =>
	SessionTimelineProjection.make({
		messages: [],
		status,
		activeTurn: null,
		turnCount: 0,
		queue: QueueState.make({ items: [], paused: false }),
		permissionMode: "default",
		runtimeMode: "approval-required",
		interactions: [...interactions],
	});
const flush = async () => {
	for (let i = 0; i < 30; i++) await Promise.resolve();
};
const setup = () => {
	let context: ResourceDriverContext<object, unknown> | null = null;
	let running = false;
	let starts = 0;
	let catalog: SessionRuntimeState = "idle";
	const catalogListeners = new Set<() => void>();
	const bus = new ClientBus({
		resolver: {
			resolve: () =>
				Effect.succeed({ client: {}, dispose: async () => undefined }),
		},
		driverFor: () => ({
			start: (ctx) => {
				context = ctx;
				running = true;
				starts++;
			},
			stop: () => {
				running = false;
			},
		}),
	});
	const publish = (
		status: "running" | "idle",
		version: number,
		interactions: SessionTimelineProjection["interactions"] = [],
	) =>
		context?.emit({
			data: projection(status, interactions),
			cursor: { epoch: "test", version },
			sync: "live",
		});
	const retain = () =>
		retainSessionActivity({
			bus,
			ref,
			catalogRuntime: () => catalog,
			subscribeCatalog: (listener) => {
				catalogListeners.add(listener);
				return () => {
					catalogListeners.delete(listener);
				};
			},
		});
	const setCatalog = (value: SessionRuntimeState) => {
		catalog = value;
		for (const listener of catalogListeners) listener();
	};
	return {
		bus,
		publish,
		retain,
		setCatalog,
		running: () => running,
		starts: () => starts,
	};
};

describe("background session activity", () => {
	it("receives completion after leaving the chat and releases the live transcript", async () => {
		const h = setup();
		const foreground = h.bus.retain(key, { activation: "connect" });
		await flush();
		h.publish("running", 1);
		h.setCatalog("running");
		const release = h.retain();
		foreground.release();
		await flush();
		expect(h.running()).toBe(true);
		expect(h.publish("idle", 2)).toBe(true);
		expect(deriveSessionPresentation({ view: h.bus.snapshot(key) }).busy).toBe(
			false,
		);
		expect(h.running()).toBe(false);

		expect(h.starts()).toBe(1);
		release();
		await h.bus.dispose();
	});
	it("refreshes an active cached timeline after the foreground has already closed", async () => {
		const h = setup();
		const foreground = h.bus.retain(key, { activation: "connect" });
		await flush();
		h.publish("running", 1);
		foreground.release();
		expect(h.running()).toBe(false);
		const release = h.retain();
		await flush();
		expect(h.running()).toBe(true);
		h.publish("idle", 2);
		expect(deriveSessionPresentation({ view: h.bus.snapshot(key) }).busy).toBe(
			false,
		);
		expect(h.running()).toBe(false);
		release();
		await h.bus.dispose();
	});
	it("shares the stream across sidebar and tabs and reconnects without reopening the chat", async () => {
		const h = setup();
		h.setCatalog("running");
		const releaseSidebar = h.retain();
		const releaseTabs = h.retain();
		await flush();
		expect(h.starts()).toBe(1);
		h.publish("running", 1);
		releaseTabs();
		expect(h.running()).toBe(true);
		h.bus.setOnline(false);
		expect(h.running()).toBe(false);
		h.bus.setOnline(true);
		await flush();
		expect(h.running()).toBe(true);
		h.publish("idle", 2);
		expect(deriveSessionPresentation({ view: h.bus.snapshot(key) }).busy).toBe(
			false,
		);
		expect(h.running()).toBe(false);
		releaseSidebar();
		await h.bus.dispose();
	});
	it.each([
		"question",
		"permission",
	] as const)("follows %s resolution without retaining expired prompts", async (kind) => {
		const h = setup();
		const foreground = h.bus.retain(key, { activation: "connect" });
		await flush();
		const interaction =
			kind === "question"
				? {
						_tag: "Question" as const,
						id: AgentItemId.make("question"),
						questions: [{ question: "Choose", options: ["A"] }],
						requestedAt: new Date(0),
					}
				: {
						_tag: "Permission" as const,
						id: "permission",
						request: PermissionRequest.make({
							id: "permission",
							sessionId: ref.sessionId,
							kind: { _tag: "Bash", command: "pwd" },
							requestedAt: new Date(0),
							forcePrompt: false,
						}),
					};
		h.publish("idle", 1, [interaction]);
		const release = h.retain();
		foreground.release();
		expect(h.running()).toBe(true);
		const expired =
			interaction._tag === "Question"
				? { ...interaction, recoveryState: "expired" as const }
				: {
						...interaction,
						request: PermissionRequest.make({
							...interaction.request,
							recoveryState: "expired",
						}),
					};
		h.publish("idle", 2, [expired]);
		await flush();
		expect(h.running()).toBe(false);
		expect(h.starts()).toBe(1);
		release();
		await h.bus.dispose();
	});

	it("only connects sessions when their catalog becomes active", async () => {
		const h = setup();
		const release = h.retain();
		await flush();
		expect(h.starts()).toBe(0);
		h.setCatalog("running");
		await flush();
		expect(h.starts()).toBe(1);
		h.publish("idle", 1);
		await flush();
		expect(h.running()).toBe(false);
		h.setCatalog("idle");
		h.setCatalog("running");
		await flush();
		expect(h.starts()).toBe(2);
		release();
		expect(h.running()).toBe(false);
		await h.bus.dispose();
	});
});
