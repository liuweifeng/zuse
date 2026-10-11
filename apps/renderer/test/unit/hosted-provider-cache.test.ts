import { Effect } from "effect";
import { afterAll, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("../../src/lib/hosted-session.ts", () => ({
	isHostedProduct: () => true,
	hostedAccountId: () => "cached-account",
}));
vi.mock("../../src/lib/rpc-client.ts", () => ({
	getControlPlaneRpcClient: async () => ({ "cloud.auth.status": mocks.status }),
}));
vi.mock("../../src/lib/environment-shell-client-bus.ts", () => ({
	dispatchEnvironmentShellCommand: vi.fn(),
}));
vi.mock("../../src/components/ui/toast.tsx", () => ({
	toastManager: { add: vi.fn() },
}));
vi.mock("../../src/store/environment-catalog.ts", () => ({
	useEnvironmentCatalogStore: {
		getState: () => ({ activeEnvironmentId: "local" }),
	},
}));
vi.mock("../../src/lib/cloud-workspace-catalog.ts", () => ({
	cloudSummaryForEnvironment: () => undefined,
}));
vi.mock("../../src/store/model-catalog.ts", () => ({
	useModelCatalogStore: {},
}));

const connected = {
	authorityState: "ready",
	providers: [{ providerId: "claude", state: "connected" }],
};
const storage = new Map([
	[
		"zuse.control-plane.v1:cached-account:cloud-workspace:auth",
		JSON.stringify({ value: connected }),
	],
]);
vi.stubGlobal("window", {
	localStorage: {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
	},
});
const { useProvidersStore } = await import("../../src/store/providers.ts");
const { loadCloudAuth, peekCloudAuth } = await import(
	"../../src/lib/cloud-workspace-session-cache.ts"
);
afterAll(() => vi.unstubAllGlobals());

it("shows cached web models immediately and applies background authentication changes", async () => {
	expect(useProvidersStore.getState().availabilityLoaded).toBe(true);
	expect(useProvidersStore.getState().availability[0]?.authStatus).toBe(
		"authenticated",
	);
	expect(mocks.status).not.toHaveBeenCalled();
	let finish!: (value: unknown) => void;
	const pending = new Promise((resolve) => {
		finish = resolve;
	});
	mocks.status.mockReturnValue(Effect.promise(() => pending));
	expect((await loadCloudAuth()).providers[0]?.state).toBe("connected");
	expect(useProvidersStore.getState().availability[0]?.authStatus).toBe(
		"authenticated",
	);
	finish({
		authorityState: "ready",
		providers: [{ providerId: "claude", state: "disconnected" }],
	});
	await vi.waitFor(() =>
		expect(useProvidersStore.getState().availability[0]?.authStatus).toBe(
			"unauthenticated",
		),
	);
	expect(peekCloudAuth()?.providers[0]?.state).toBe("disconnected");
	expect(useProvidersStore.getState().availabilityLoaded).toBe(true);
	expect(mocks.status).toHaveBeenCalledTimes(1);
});
