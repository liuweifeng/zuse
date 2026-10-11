import { emptyResourceView } from "@zuse/client-runtime/resource-state";
import { EnvironmentId, Folder, FolderId } from "@zuse/contracts";
import { Effect } from "effect";
import { afterEach, expect, test, vi } from "vitest";

const folder = (id: string, workspaceKey?: string) =>
	Folder.make({
		id: FolderId.make(id),
		path: `/repos/${id}`,
		name: id,
		addedAt: new Date(0),
		...(workspaceKey === undefined ? {} : { workspaceKey }),
	});

// This desktop's server returns every workspace's projects in one shell.
const shell = vi.hoisted(() => ({ data: null as unknown }));
const connection = vi.hoisted(() => ({
	listener: null as null | ((snapshot: { status: string }) => void),
	describeFailure: null as Error | null,
	wait: null as Promise<void> | null,
	calls: 0,
}));
vi.mock("../../src/lib/rpc-client.ts", async (original) => ({
	...(await original<typeof import("../../src/lib/rpc-client.ts")>()),
	subscribeRendererRpcConnection: (listener: typeof connection.listener) => {
		connection.listener = listener;
		return () => {
			connection.listener = null;
		};
	},
}));

vi.mock("../../src/lib/runtime-operation-client.ts", () => ({
	runtimeOperationClient: async () => {
		connection.calls++;
		const failure = connection.describeFailure;
		if (connection.wait) await connection.wait;
		return {
			"connect.describe": () =>
				failure !== null
					? Effect.fail(failure)
					: Effect.succeed({
							environmentId: EnvironmentId.make("this-desktop"),
							label: "Laptop",
						}),
			"environments.list": () => Effect.succeed({ environments: [] }),
		};
	},
}));
vi.mock("../../src/lib/environment-shell-client-bus.ts", async (original) => {
	const actual =
		await original<
			typeof import("../../src/lib/environment-shell-client-bus.ts")
		>();
	const { scopeEnvironmentShellView } = await import(
		"../../src/lib/environment-shell-scope.ts"
	);
	const { rendererWorkspaceSnapshot } = await import(
		"../../src/lib/renderer-workspace.ts"
	);
	const view = () => ({ ...emptyResourceView(), data: shell.data });
	return {
		...actual,
		retainEnvironmentShell: () => ({
			lease: { release: () => undefined, activate: () => undefined },
		}),
		subscribeEnvironmentShell: () => () => undefined,
		environmentShellSnapshot: (ref: { environmentId: string }) =>
			scopeEnvironmentShellView(
				ref.environmentId,
				view() as never,
				rendererWorkspaceSnapshot().scope,
			),
	};
});

import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import { selectRendererWorkspace } from "../../src/lib/renderer-workspace.ts";
import { environmentBelongsToWorkspace } from "../../src/lib/rpc-client.ts";
import { useEnvironmentCatalogStore } from "../../src/store/environment-catalog.ts";
import { useWorkspaceStore } from "../../src/store/workspace.ts";

afterEach(() => {
	observeRendererAccount(null);
	vi.unstubAllGlobals();
});

test("organization startup shows only this desktop's projects linked to the organization", async () => {
	vi.stubGlobal("location", new URL("http://localhost:3000"));
	vi.stubGlobal("window", { setTimeout, clearTimeout });
	shell.data = {
		folders: [
			folder("personal-repo"),
			folder("org-repo", "organization:org-test"),
		],
		originsByFolder: {},
		chatsByProject: { "personal-repo": [], "org-repo": [] },
		sessionsByProject: { "personal-repo": [], "org-repo": [] },
		creationOperationsByProject: {},
	};
	observeRendererAccount("test-user");
	selectRendererWorkspace({ kind: "organization", organizationId: "org-test" });
	useEnvironmentCatalogStore.setState({
		initialized: false,
		initializing: false,
		entries: [],
		initializationError: null,
	});
	await expect(
		useEnvironmentCatalogStore.getState().initialize(),
	).resolves.toBeUndefined();
	expect(useEnvironmentCatalogStore.getState().initializationError).toBeNull();
	expect(environmentBelongsToWorkspace("this-desktop")).toBe(true);
	expect(useWorkspaceStore.getState().folders.map((f) => f.id)).toEqual([
		"org-repo",
	]);

	// Switching workspace re-projects the same desktop for the new owner.
	selectRendererWorkspace({ kind: "personal" });
	expect(useWorkspaceStore.getState().folders.map((f) => f.id)).toEqual([
		"personal-repo",
	]);
	expect(useWorkspaceStore.getState().selectedFolderId).toBe("personal-repo");
	selectRendererWorkspace({ kind: "organization", organizationId: "other" });
	expect(useWorkspaceStore.getState().folders).toEqual([]);
});

test("recovers failed local discovery when the engine reconnects without manual retry", async () => {
	vi.stubGlobal("location", new URL("http://localhost:3000"));
	vi.stubGlobal("window", { setTimeout, clearTimeout });
	selectRendererWorkspace({ kind: "personal" });
	shell.data = {
		folders: [folder("recovered-repo")],
		originsByFolder: {},
		chatsByProject: {},
		sessionsByProject: {},
		creationOperationsByProject: {},
	};
	useEnvironmentCatalogStore.setState({
		initialized: false,
		initializing: false,
		entries: [],
		initializationError: null,
	});
	connection.describeFailure = new Error("The local engine disconnected.");
	await expect(
		useEnvironmentCatalogStore.getState().initialize(),
	).rejects.toThrow("The local engine disconnected.");
	expect(useEnvironmentCatalogStore.getState().initializationError).toContain(
		"local engine disconnected",
	);
	// A healthy transport does not guarantee successful discovery. Keep a real
	// failure visible and do not turn the recovery edge into a retry loop.
	const failedCalls = connection.calls;
	connection.listener?.({ status: "connected" });
	await vi.waitFor(() =>
		expect(useEnvironmentCatalogStore.getState().initializing).toBe(false),
	);
	expect(connection.calls).toBe(failedCalls + 1);
	expect(useEnvironmentCatalogStore.getState().initialized).toBe(false);
	expect(useEnvironmentCatalogStore.getState().initializationError).toContain(
		"local engine disconnected",
	);
	connection.describeFailure = null;
	connection.listener?.({ status: "connected" });
	await vi.waitFor(() =>
		expect(useEnvironmentCatalogStore.getState().initialized).toBe(true),
	);
	expect(useEnvironmentCatalogStore.getState().initializationError).toBeNull();
	expect(useWorkspaceStore.getState().folders.map((f) => f.id)).toEqual([
		"recovered-repo",
	]);
});

test("coalesces manual retry and a reconnect while failed discovery is still settling", async () => {
	vi.stubGlobal("location", new URL("http://localhost:3000"));
	vi.stubGlobal("window", { setTimeout, clearTimeout });
	selectRendererWorkspace({ kind: "personal" });
	shell.data = {
		folders: [folder("race-repo")],
		originsByFolder: {},
		chatsByProject: {},
		sessionsByProject: {},
		creationOperationsByProject: {},
	};
	useEnvironmentCatalogStore.setState({
		initialized: false,
		initializing: false,
		entries: [],
		initializationError: null,
	});
	let release = () => {};
	connection.wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	connection.describeFailure = new Error("The local engine disconnected.");
	const calls = connection.calls;
	const first = useEnvironmentCatalogStore.getState().initialize();
	const manual = useEnvironmentCatalogStore.getState().initialize();
	const settled = Promise.allSettled([first, manual]);
	expect(connection.calls).toBe(calls + 1);
	connection.listener?.({ status: "reconnecting" });
	connection.describeFailure = null;
	connection.wait = null;
	connection.listener?.({ status: "connected" });
	release();
	await settled;
	await vi.waitFor(() =>
		expect(useEnvironmentCatalogStore.getState().initialized).toBe(true),
	);
	expect(connection.calls).toBe(calls + 2);
	expect(useEnvironmentCatalogStore.getState().initializationError).toBeNull();
	expect(useWorkspaceStore.getState().folders.map((f) => f.id)).toEqual([
		"race-repo",
	]);
});
