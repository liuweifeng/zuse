import type { CloudAccountImage } from "@zuse/contracts";
import { WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
	calls: [] as { method: string; input: unknown }[],
	reject: false,
}));

vi.mock("../../src/lib/control-plane-client.ts", () => ({
	runCloudControl: async (
		effect: (client: Record<string, (input: unknown) => unknown>) => unknown,
	) => {
		const client = new Proxy(
			{},
			{
				get: (_target, method: string) => (input: unknown) => {
					control.calls.push({ method, input });
					return input;
				},
			},
		);
		effect(client);
		if (control.reject) throw new Error("rejected");
		return {};
	},
}));
vi.mock("../../src/store/chats.ts", () => ({
	useChatsStore: { getState: () => ({ selectedChatId: null }) },
}));
vi.mock("../../src/lib/cloud-workspace-catalog.ts", () => ({
	cloudSummaryForChat: () => null,
}));
vi.mock("../../src/lib/environment-shell-client-bus.ts", () => ({
	environmentShellSnapshot: () => ({ connection: "offline" }),
}));
vi.mock("../../src/lib/renderer-account.ts", () => ({
	subscribeRendererAccount: () => () => {},
}));
vi.mock("../../src/lib/rpc-client.ts", () => ({
	getRpcClient: async () => ({}),
}));
vi.mock("../../src/lib/session-timeline-client-bus.ts", () => ({
	getRendererClientBus: () => ({}),
	sessionTimelineResourceKey: () => "",
}));

const {
	catchUpCloudImageRuntimes,
	cloudRuntimeUpdating,
	noteCloudRuntimeConnection,
	requestCloudWorkspaceRuntimeUpdate,
} = await import("../../src/lib/cloud-runtime-catch-up.ts");

const image = (patch: Partial<CloudAccountImage>): CloudAccountImage => ({
	providerId: "boxd",
	state: "ready",
	repositories: [],
	providers: [],
	builds: [],
	updatedAt: 1,
	...patch,
});

beforeEach(() => {
	control.calls = [];
	control.reject = false;
});

describe("cloud runtime catch-up", () => {
	it("queues one update build per provider for images behind this app", () => {
		catchUpCloudImageRuntimes([
			image({ providerId: "boxd" }),
			image({
				providerId: "e2b",
				runtime: {
					appVersion: "x",
					wireProtocolVersion: WIRE_PROTOCOL_VERSION,
				},
			}),
		]);
		catchUpCloudImageRuntimes([image({ providerId: "boxd" })]);
		expect(control.calls).toEqual([
			{
				method: "cloud.image.build",
				input: {
					mode: "update",
					providerId: "boxd",
					idempotencyKey: `runtime-catch-up:boxd:${WIRE_PROTOCOL_VERSION}`,
				},
			},
		]);
	});

	it("blocks sending until the workspace reconnects and never loops after a rollback", async () => {
		const legacyClient = {};
		expect(
			await requestCloudWorkspaceRuntimeUpdate("workspace-a", legacyClient),
		).toBe(true);
		expect(cloudRuntimeUpdating("workspace-a")).toBe(true);
		// The same connection shares the in-flight update.
		expect(
			await requestCloudWorkspaceRuntimeUpdate("workspace-a", legacyClient),
		).toBe(true);
		expect(control.calls).toHaveLength(1);

		noteCloudRuntimeConnection("workspace-a", WIRE_PROTOCOL_VERSION - 1);
		expect(cloudRuntimeUpdating("workspace-a")).toBe(false);
		// A new connection that is still legacy means the update did not take.
		expect(await requestCloudWorkspaceRuntimeUpdate("workspace-a", {})).toBe(
			false,
		);
		expect(control.calls).toHaveLength(1);
	});

	it("releases the send block and allows a retry when the request is rejected", async () => {
		control.reject = true;
		const client = {};
		expect(
			await requestCloudWorkspaceRuntimeUpdate("workspace-b", client),
		).toBe(false);
		expect(cloudRuntimeUpdating("workspace-b")).toBe(false);
		control.reject = false;
		expect(
			await requestCloudWorkspaceRuntimeUpdate("workspace-b", client),
		).toBe(true);
		expect(control.calls).toHaveLength(2);
	});
});
