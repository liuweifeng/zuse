import { CloudWorkspaceOpError } from "@zuse/contracts";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import { selectRendererWorkspace } from "../../src/lib/renderer-workspace.ts";

vi.mock("../../src/lib/hosted-connect.ts", () => ({
	isHostedProduct: () => false,
}));

vi.mock("../../src/lib/rpc-client.ts", () => ({
	getControlPlaneRpcClient: vi.fn(async () => ({})),
}));

const {
	clearControlPlaneSessionCache,
	invalidateControlPlaneCache,
	peekControlPlaneCache,
	setControlPlaneCacheAccount,
	runCachedControlPlane,
	subscribeControlPlaneSessionCache,
} = await import("../../src/lib/control-plane-client.ts");

describe("control-plane session cache", () => {
	afterEach(() => vi.useRealTimers());
	beforeEach(() => {
		clearControlPlaneSessionCache();
		vi.useRealTimers();
	});

	it("reuses immutable values until explicitly refreshed", async () => {
		let calls = 0;
		const load = (refresh = false) =>
			runCachedControlPlane("stable", () => Effect.succeed(++calls), {
				refresh,
			});

		expect(await load()).toBe(1);
		expect(await load()).toBe(1);
		expect(await load(true)).toBe(2);
	});

	it("reuses successful reads for the entire app session", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const load = () =>
			runCachedControlPlane("mutable", () => Effect.succeed(++calls));

		expect(await load()).toBe(1);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(await load()).toBe(1);
		await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1_000);
		expect(await load()).toBe(1);
		expect(calls).toBe(1);
	});

	it("evicts failed requests so callers can retry", async () => {
		let calls = 0;
		const load = () =>
			runCachedControlPlane("retry", () => {
				calls += 1;
				return calls === 1
					? Effect.fail(new Error("offline"))
					: Effect.succeed(calls);
			});

		await expect(load()).rejects.toThrow("offline");
		expect(await load()).toBe(2);
	});
	it("returns cached data during explicit refreshes and publishes the update", async () => {
		vi.useFakeTimers();
		let complete!: (value: number) => void;
		const pending = new Promise<number>((resolve) => {
			complete = resolve;
		});
		let calls = 0;
		const load = (refresh = false) =>
			runCachedControlPlane(
				"cloud",
				() => {
					calls += 1;
					return calls === 1
						? Effect.succeed(1)
						: Effect.promise(() => pending);
				},
				{ refresh },
			);
		expect(await load()).toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		const changed = vi.fn();
		const unsubscribe = subscribeControlPlaneSessionCache(changed);
		expect(await load()).toBe(1);
		const refreshing = load(true);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(await load()).toBe(1);
		expect(calls).toBe(2);
		complete(2);
		expect(await refreshing).toBe(2);
		expect(changed).toHaveBeenCalledExactlyOnceWith("cloud");
		expect(await load()).toBe(2);
		expect(calls).toBe(2);
		unsubscribe();
	});

	it("keeps successful data after failed refreshes and still reports explicit refresh errors", async () => {
		vi.useFakeTimers();
		let offline = false;
		const load = (refresh = false) =>
			runCachedControlPlane(
				"cloud",
				() => (offline ? Effect.fail(new Error("offline")) : Effect.succeed(1)),
				{ refresh },
			);
		expect(await load()).toBe(1);
		offline = true;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await load()).toBe(1);
		await expect(load(true)).rejects.toThrow("offline");
		expect(await load()).toBe(1);
	});

	it("does not restore cleared account data when an old request finishes", async () => {
		let complete!: (value: number) => void;
		const pending = new Promise<number>((resolve) => {
			complete = resolve;
		});
		const previous = runCachedControlPlane("cloud-workspace:account", () =>
			Effect.promise(() => pending),
		);
		clearControlPlaneSessionCache("cloud-workspace:");
		expect(
			await runCachedControlPlane("cloud-workspace:account", () =>
				Effect.succeed(2),
			),
		).toBe(2);
		complete(1);
		await previous;
		expect(
			await runCachedControlPlane("cloud-workspace:account", () =>
				Effect.succeed(3),
			),
		).toBe(2);
	});

	it("deduplicates slow cold reads and retains their results", async () => {
		vi.useFakeTimers();
		let complete!: (value: number) => void;
		const pending = new Promise<number>((resolve) => {
			complete = resolve;
		});
		const read = vi.fn(() => Effect.promise(() => pending));
		const load = () => runCachedControlPlane("slow", read);
		const first = load();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(load()).toBe(first);
		complete(1);
		await first;
		await vi.advanceTimersByTimeAsync(4_999);
		expect(await load()).toBe(1);
		expect(read).toHaveBeenCalledTimes(1);
	});
	it("refreshes after a mutation without reusing an older in-flight read", async () => {
		let complete!: (value: number) => void;
		const pending = new Promise<number>((resolve) => {
			complete = resolve;
		});
		const oldRead = runCachedControlPlane("cloud", () =>
			Effect.promise(() => pending),
		);
		expect(
			await runCachedControlPlane("cloud", () => Effect.succeed(2), {
				refresh: true,
			}),
		).toBe(2);
		complete(1);
		await oldRead;
		expect(await runCachedControlPlane("cloud", () => Effect.succeed(3))).toBe(
			2,
		);
	});
});

describe("persistent display cache", () => {
	const decode = (value: unknown): { connected: boolean } => {
		if (
			typeof value !== "object" ||
			value === null ||
			!("connected" in value) ||
			typeof value.connected !== "boolean"
		)
			throw new Error("Invalid snapshot");
		return { connected: value.connected };
	};
	const key = "cloud-workspace:auth";
	let stored: Map<string, string>;
	beforeEach(() => {
		clearControlPlaneSessionCache();
		setControlPlaneCacheAccount("account-a");
		stored = new Map();
		vi.stubGlobal("window", {
			localStorage: {
				getItem: (key: string) => stored.get(key) ?? null,
				removeItem: (key: string) => stored.delete(key),
				setItem: (key: string, value: string) => stored.set(key, value),
			},
		});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
		setControlPlaneCacheAccount(null);
	});
	it("invalidates both in-memory and persisted snapshots after a mutation", () => {
		const storageKey = `zuse.control-plane.v1:account-a:${key}`;
		stored.set(storageKey, JSON.stringify({ value: { connected: true } }));
		expect(peekControlPlaneCache(key, decode)).toEqual({ connected: true });
		invalidateControlPlaneCache(key);
		expect(stored.has(storageKey)).toBe(false);
		expect(peekControlPlaneCache(key, decode)).toBeUndefined();
	});

	const save = () =>
		runCachedControlPlane(key, () => Effect.succeed({ connected: true }), {
			decode,
		});

	it("restores immediately after a reload and deduplicates background refreshes", async () => {
		await save();
		clearControlPlaneSessionCache();
		expect(peekControlPlaneCache(key, decode)).toEqual({ connected: true });
		let finish!: (value: { connected: boolean }) => void;
		const request = new Promise<{ connected: boolean }>((resolve) => {
			finish = resolve;
		});
		const fetch = vi.fn(() => Effect.promise(() => request));
		const changed = vi.fn();
		const unsubscribe = subscribeControlPlaneSessionCache(changed);
		expect(await runCachedControlPlane(key, fetch, { decode })).toEqual({
			connected: true,
		});
		expect(await runCachedControlPlane(key, fetch, { decode })).toEqual({
			connected: true,
		});
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		finish({ connected: false });
		await vi.waitFor(() =>
			expect(peekControlPlaneCache(key, decode)).toEqual({ connected: false }),
		);
		expect(changed).toHaveBeenCalledExactlyOnceWith(key);
		unsubscribe();
	});

	it("retains stale data on failure and suppresses unchanged updates", async () => {
		await save();
		const original = peekControlPlaneCache(key, decode);
		const changed = vi.fn();
		const unsubscribe = subscribeControlPlaneSessionCache(changed);
		await runCachedControlPlane(
			key,
			() => Effect.succeed({ connected: true }),
			{ decode, refresh: true },
		);
		expect(peekControlPlaneCache(key, decode)).toBe(original);
		expect(changed).not.toHaveBeenCalled();
		await expect(
			runCachedControlPlane(key, () => Effect.fail(new Error("offline")), {
				decode,
				refresh: true,
			}),
		).rejects.toThrow("offline");
		expect(peekControlPlaneCache(key, decode)).toBe(original);
		unsubscribe();
	});

	it("isolates accounts and ignores malformed persisted data", async () => {
		await save();
		setControlPlaneCacheAccount("account-b");
		expect(peekControlPlaneCache(key, decode)).toBeUndefined();
		setControlPlaneCacheAccount("account-a");
		clearControlPlaneSessionCache();
		for (const storageKey of stored.keys())
			stored.set(storageKey, JSON.stringify({ value: { connected: "bad" } }));
		expect(peekControlPlaneCache(key, decode)).toBeUndefined();
		expect(await save()).toEqual({ connected: true });
	});

	it("discards memory and persisted display data when access is revoked", async () => {
		await save();
		await expect(
			runCachedControlPlane(
				key,
				() => Effect.fail(new CloudWorkspaceOpError({ code: "not-allowed" })),
				{ decode, refresh: true },
			),
		).rejects.toMatchObject({ code: "not-allowed" });
		expect(peekControlPlaneCache(key, decode)).toBeUndefined();
		clearControlPlaneSessionCache();
		expect(peekControlPlaneCache(key, decode)).toBeUndefined();
		expect(stored.size).toBe(0);
	});

	it("throttles revalidation for five minutes without expiring the display snapshot", async () => {
		vi.useFakeTimers();
		await save();
		const fetch = vi.fn(() => Effect.succeed({ connected: false }));
		await vi.advanceTimersByTimeAsync(299_999);
		await runCachedControlPlane(key, fetch, { decode });
		expect(fetch).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(await runCachedControlPlane(key, fetch, { decode })).toEqual({
			connected: true,
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(peekControlPlaneCache(key, decode)).toEqual({ connected: false });
	});

	it("continues working when browser storage is unavailable", async () => {
		vi.stubGlobal("window", {
			get localStorage() {
				throw new Error("disabled");
			},
		});
		expect(await save()).toEqual({ connected: true });
		expect(peekControlPlaneCache(key, decode)).toEqual({ connected: true });
	});

	it("keeps persisted organization snapshots separate from Personal and other organizations", async () => {
		observeRendererAccount("account-a");
		try {
			await save();
			selectRendererWorkspace({
				kind: "organization",
				organizationId: "org-a",
			});
			expect(peekControlPlaneCache(key, decode)).toBeUndefined();
			await runCachedControlPlane(
				key,
				() => Effect.succeed({ connected: false }),
				{ decode },
			);
			clearControlPlaneSessionCache();
			expect(peekControlPlaneCache(key, decode)).toEqual({ connected: false });
			selectRendererWorkspace({
				kind: "organization",
				organizationId: "org-b",
			});
			expect(peekControlPlaneCache(key, decode)).toBeUndefined();
			selectRendererWorkspace({ kind: "personal" });
			expect(peekControlPlaneCache(key, decode)).toEqual({ connected: true });
		} finally {
			observeRendererAccount(null);
		}
	});

	it("shares account-scoped snapshots across workspaces and persists them", async () => {
		observeRendererAccount("account-a");
		try {
			const plugins = (value: boolean) =>
				runCachedControlPlane(
					"plugins:list:personal",
					() => Effect.succeed({ connected: value }),
					{ decode, scope: "account" },
				);
			await plugins(true);
			selectRendererWorkspace({
				kind: "organization",
				organizationId: "org-a",
			});
			expect(
				peekControlPlaneCache("plugins:list:personal", decode, "account"),
			).toEqual({ connected: true });
			clearControlPlaneSessionCache();

			expect(
				peekControlPlaneCache("plugins:list:personal", decode, "account"),
			).toEqual({ connected: true });
			selectRendererWorkspace({ kind: "personal" });
		} finally {
			observeRendererAccount(null);
		}
	});
});
