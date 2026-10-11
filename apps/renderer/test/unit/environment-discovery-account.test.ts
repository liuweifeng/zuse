import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	connect: vi.fn(),
	describe: vi.fn(),
	snapshot: vi.fn(),
	subscribe: vi.fn(),
	remove: vi.fn(async () => undefined),
	setActive: vi.fn(),
	release: vi.fn(),
	unsubscribe: vi.fn(),
}));
vi.mock("../../src/lib/rpc-client.ts", async (original) => ({
	...(await original<typeof import("../../src/lib/rpc-client.ts")>()),
	removeRendererEnvironment: mocks.remove,
	setActiveEnvironment: mocks.setActive,
	subscribeRendererRpcConnection: () => () => undefined,
}));
vi.mock("../../src/lib/environment-shell-client-bus.ts", async (original) => ({
	...(await original<
		typeof import("../../src/lib/environment-shell-client-bus.ts")
	>()),
	retainEnvironmentShell: () => ({
		lease: { release: mocks.release, activate: () => undefined },
	}),
	subscribeEnvironmentShell: mocks.subscribe,
	environmentShellSnapshot: mocks.snapshot,
}));
vi.mock("../../src/lib/runtime-operation-client.ts", () => ({
	runtimeOperationClient: async () => ({
		"environments.list": mocks.list,
		"environments.connect": mocks.connect,
		"connect.describe": mocks.describe,
	}),
}));

import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import {
	type EnvironmentCatalogEntry,
	useEnvironmentCatalogStore,
} from "../../src/store/environment-catalog.ts";
import { useWorkspaceStore } from "../../src/store/workspace.ts";

const local: EnvironmentCatalogEntry = {
	connectionKind: "local",
	environmentId: "local",
	profileId: null,
	label: "Local",
	target: null,
	descriptor: null,
	status: "connected",
	error: null,
};
const ssh: EnvironmentCatalogEntry = {
	...local,
	connectionKind: "ssh",
	environmentId: "manual",
	profileId: "manual-profile",
};
const deferred = () => {
	let resolve!: (value: {
		environments: Array<{ environmentId: string; label: string }>;
	}) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<{
		environments: Array<{ environmentId: string; label: string }>;
	}>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
};

beforeEach(() => {
	useEnvironmentCatalogStore.setState({ initialized: false });
	observeRendererAccount(null);
	observeRendererAccount("first");
	useEnvironmentCatalogStore.setState({
		entries: [local, ssh],
		initialized: false,
		accountDiscoveryError: null,
		activeEnvironmentId: "local",
	});
	mocks.remove.mockClear();
	mocks.setActive.mockClear();
	mocks.release.mockClear();
	mocks.unsubscribe.mockClear();
	mocks.snapshot
		.mockReset()
		.mockReturnValue({ data: null, connection: "dormant" });
	mocks.describe
		.mockReset()
		.mockImplementation(() =>
			Effect.succeed({ environmentId: "local", label: "Local" }),
		);
	mocks.subscribe.mockReset().mockImplementation(() => mocks.unsubscribe);
	mocks.connect.mockReset().mockImplementation(() =>
		Effect.succeed({
			endpoint: { wsBaseUrl: "wss://example.test/rpc" },
			connectToken: "test-token",
		}),
	);
	mocks.list
		.mockReset()
		.mockImplementation(() => Effect.succeed({ environments: [] }));
});

afterEach(() => vi.unstubAllGlobals());

it("releases transient cloud shells and clears their projection on account change", async () => {
	const data = {
		folders: [],
		originsByFolder: {},
		chatsByProject: {},
		sessionsByProject: {},
		creationOperationsByProject: {},
	};
	mocks.snapshot.mockReturnValue({ data, connection: "connected" });
	await useEnvironmentCatalogStore
		.getState()
		.activateTransient("cloud-only", data);
	expect(useEnvironmentCatalogStore.getState().activeEnvironmentId).toBe(
		"cloud-only",
	);
	observeRendererAccount("second");
	expect(mocks.release).toHaveBeenCalledOnce();
	expect(mocks.remove).toHaveBeenCalledWith("cloud-only");
	expect(useEnvironmentCatalogStore.getState().activeEnvironmentId).toBe(
		"local",
	);
	expect(useEnvironmentCatalogStore.getState().entries).toEqual([local, ssh]);
});

it("does not discover account servers while signed out", async () => {
	observeRendererAccount(null);
	await useEnvironmentCatalogStore.getState().syncAccountEnvironments();
	expect(mocks.list).not.toHaveBeenCalled();
	expect(useEnvironmentCatalogStore.getState().entries).toEqual([local, ssh]);
});

it("keeps startup device profiles and retires a duplicate API route discovered during sign-in", async () => {
	observeRendererAccount(null);
	const profiles = [
		{
			profileId: "saved-ssh",
			environmentId: "same-host",
			label: "Saved SSH",
			target: { hostname: "host", user: null, port: null },
		},
	];
	let resolve!: (value: typeof profiles) => void;
	const pendingProfiles = new Promise<typeof profiles>((done) => {
		resolve = done;
	});
	vi.stubGlobal("window", {
		zuse: { ssh: { listProfiles: () => pendingProfiles } },
	});
	mocks.snapshot.mockReturnValue({
		connection: "connected",
		data: {
			folders: [],
			originsByFolder: {},
			chatsByProject: {},
			sessionsByProject: {},
			creationOperationsByProject: {},
		},
	});
	const initialized = useEnvironmentCatalogStore.getState().initialize();
	await vi.waitFor(() =>
		expect(useEnvironmentCatalogStore.getState().initialized).toBe(true),
	);
	expect(mocks.list).not.toHaveBeenCalled();
	mocks.list.mockImplementationOnce(() =>
		Effect.succeed({
			environments: [{ environmentId: "same-host", label: "Account route" }],
		}),
	);
	observeRendererAccount("signed-in");
	await vi.waitFor(() =>
		expect(
			useEnvironmentCatalogStore
				.getState()
				.entries.some((entry) => entry.connectionKind === "api"),
		).toBe(true),
	);
	resolve(profiles);
	await initialized;
	expect(
		useEnvironmentCatalogStore
			.getState()
			.entries.map((entry) => entry.connectionKind),
	).toEqual(["local", "ssh"]);
	expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("same-host");
	expect(mocks.release).toHaveBeenCalledOnce();
	expect(useEnvironmentCatalogStore.getState().entries[1]?.profileId).toBe(
		"saved-ssh",
	);
});

it("clears account entries and releases their subscriptions without removing device profiles", async () => {
	mocks.list.mockImplementationOnce(() =>
		Effect.succeed({
			environments: [
				{ environmentId: "account-server", label: "Account server" },
			],
		}),
	);
	await useEnvironmentCatalogStore.getState().syncAccountEnvironments();
	expect(useEnvironmentCatalogStore.getState().entries).toHaveLength(3);
	observeRendererAccount("first");
	expect(mocks.release).not.toHaveBeenCalled();
	observeRendererAccount(null);
	expect(useEnvironmentCatalogStore.getState().entries).toEqual([local, ssh]);
	expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("account-server");
	expect(mocks.release).toHaveBeenCalledOnce();
	expect(mocks.unsubscribe).toHaveBeenCalledOnce();
});

it("refreshes the initialized catalog for a newly signed-in account, but not on sign-out", async () => {
	useEnvironmentCatalogStore.setState({ initialized: true });
	observeRendererAccount("second");
	await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
	observeRendererAccount(null);
	await Promise.resolve();
	expect(mocks.list).toHaveBeenCalledOnce();
	expect(useEnvironmentCatalogStore.getState().entries).toEqual([local, ssh]);
});

it("reconciles successful discovery removals and clears the active remote projection", async () => {
	mocks.list.mockImplementationOnce(() =>
		Effect.succeed({
			environments: [
				{ environmentId: "account-server", label: "Account server" },
			],
		}),
	);
	await useEnvironmentCatalogStore.getState().syncAccountEnvironments();
	useEnvironmentCatalogStore.setState({
		activeEnvironmentId: "account-server",
	});
	await useEnvironmentCatalogStore.getState().syncAccountEnvironments();
	expect(useEnvironmentCatalogStore.getState().entries).toEqual([local, ssh]);
	expect(useEnvironmentCatalogStore.getState().activeEnvironmentId).toBe(
		"local",
	);
	expect(mocks.setActive).toHaveBeenLastCalledWith("local");
	expect(useWorkspaceStore.getState().selectedFolderId).toBeNull();
	expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("account-server");
	await useEnvironmentCatalogStore.getState().syncAccountEnvironments();
	expect(mocks.remove).toHaveBeenCalledOnce();
});

it("cancels a pending remote activation when account access is removed", async () => {
	mocks.list.mockImplementationOnce(() =>
		Effect.succeed({
			environments: [
				{ environmentId: "account-server", label: "Account server" },
			],
		}),
	);
	await useEnvironmentCatalogStore.getState().syncAccountEnvironments();
	const pending = useEnvironmentCatalogStore
		.getState()
		.activate("account-server");
	const rejected = expect(pending).rejects.toThrow(
		"Environment subscription was removed",
	);
	await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));
	observeRendererAccount(null);
	await rejected;
	expect(useEnvironmentCatalogStore.getState().activeEnvironmentId).toBe(
		"local",
	);
	expect(mocks.release).toHaveBeenCalledOnce();
	expect(mocks.unsubscribe).toHaveBeenCalledTimes(2);
});

it.each([
	false,
	true,
])("ignores stale discovery after A -> B -> A (failure: %s)", async (failure) => {
	const old = deferred();
	mocks.list.mockImplementationOnce(() =>
		Effect.tryPromise({ try: () => old.promise, catch: (cause) => cause }),
	);
	const pending = useEnvironmentCatalogStore
		.getState()
		.syncAccountEnvironments();
	await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
	observeRendererAccount("second");
	observeRendererAccount("first");
	if (failure) old.reject(new Error("old account failure"));
	else
		old.resolve({
			environments: [{ environmentId: "old-private", label: "Private" }],
		});
	await pending;
	expect(useEnvironmentCatalogStore.getState().entries).toEqual([local, ssh]);
	expect(
		useEnvironmentCatalogStore.getState().accountDiscoveryError,
	).toBeNull();
});

it("does not let an older same-account refresh supersede a newer response", async () => {
	const old = deferred();
	mocks.list.mockImplementationOnce(() => Effect.promise(() => old.promise));
	const pending = useEnvironmentCatalogStore
		.getState()
		.syncAccountEnvironments();
	await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
	await useEnvironmentCatalogStore.getState().syncAccountEnvironments();
	old.resolve({
		environments: [{ environmentId: "removed-server", label: "Old" }],
	});
	await pending;
	expect(useEnvironmentCatalogStore.getState().entries).toEqual([local, ssh]);
});

it("still reports a failure from the current discovery request", async () => {
	mocks.list.mockImplementation(() =>
		Effect.fail(new Error("current lookup failed")),
	);
	await expect(
		useEnvironmentCatalogStore.getState().syncAccountEnvironments(),
	).rejects.toThrow("current lookup failed");
	expect(useEnvironmentCatalogStore.getState().entries).toEqual([local, ssh]);
});
