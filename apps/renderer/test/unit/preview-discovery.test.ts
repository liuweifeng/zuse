import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPreviewDiscovery,
	type DiscoveredPreview,
} from "../../src/lib/preview-discovery.ts";

const server = (port: number): DiscoveredPreview => ({
	name: "node",
	port,
	loopbackOnly: true,
	isWebServer: true,
});
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("preview discovery", () => {
	it("publishes an explicitly requested 3001 on a legacy runtime without publishing other sockets", async () => {
		const publish = vi.fn(async () => "https://p3001.chat.boxd.sh");
		const forward = vi.fn(async () => 13001);
		const discovery = createPreviewDiscovery({
			list: async () => [
				{ ...server(34903), isWebServer: undefined },
				{ ...server(3001), isWebServer: undefined, explicitlyRequested: true },
			],
			publish,
			forward,
		});
		const stop = discovery.subscribe(vi.fn());
		await flush();
		expect(publish.mock.calls).toEqual([[3001]]);
		expect(forward.mock.calls).toEqual([[3001]]);
		expect(discovery.getSnapshot()[1]).toMatchObject({
			publicUrl: "https://p3001.chat.boxd.sh",
			localUrl: "http://localhost:13001",
			forwardingState: "ready",
		});
		stop();
	});
	it("makes no forwarding or publishing requests with both modes off", async () => {
		const discovery = createPreviewDiscovery({
			list: async () => [{ ...server(3001), explicitlyRequested: true }],
		});
		const stop = discovery.subscribe(vi.fn());
		await flush();
		expect(discovery.getSnapshot()[0]).toMatchObject({
			publicUrl: undefined,
			localUrl: undefined,
			publicationState: undefined,
			forwardingState: undefined,
		});
		stop();
	});
	it("still forwards locally if the preview provider fails", async () => {
		const discovery = createPreviewDiscovery({
			list: async () => [server(3001)],
			publish: async () => {
				throw new Error("provider unavailable");
			},
			forward: async () => 13001,
		});
		const stop = discovery.subscribe(vi.fn());
		await flush();
		expect(discovery.getSnapshot()[0]).toMatchObject({
			publicationState: "failed",
			localUrl: "http://localhost:13001",
		});
		stop();
	});

	it("never publishes unverified sockets from older runtimes", async () => {
		const publish = vi.fn(async () => "https://preview.boxd.sh");
		const discovery = createPreviewDiscovery({
			list: async () => [
				{ ...server(34903), isWebServer: undefined },
				{ ...server(36063), isWebServer: false },
				{ ...server(57073), isWebServer: false },
				server(3001),
			],
			publish,
		});
		const stop = discovery.subscribe(vi.fn());
		await flush();
		expect(publish.mock.calls).toEqual([[3001]]);
		expect(
			discovery
				.getSnapshot()
				.filter((s) => s.publicationState)
				.map((s) => s.port),
		).toEqual([3001]);
		stop();
	});
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("shares polling, publishes multiple localhost ports, and retains stable snapshots", async () => {
		const list = vi
			.fn()
			.mockResolvedValue([server(3000), server(5173), server(22)]);
		const publish = vi.fn(
			async (port: number) => `https://p${port}.chat-a.boxd.sh`,
		);
		const discovery = createPreviewDiscovery({ list, publish });
		const stopChat = discovery.subscribe(vi.fn());
		const stopBrowser = discovery.subscribe(vi.fn());
		await flush();
		expect(list).toHaveBeenCalledTimes(1);
		expect(publish.mock.calls).toEqual([[3000], [5173]]);
		expect(discovery.getSnapshot().map((row) => row.publicUrl)).toEqual([
			"https://p3000.chat-a.boxd.sh",
			"https://p5173.chat-a.boxd.sh",
			undefined,
		]);
		const snapshot = discovery.getSnapshot();
		stopChat();
		await vi.advanceTimersByTimeAsync(5000);
		expect(list).toHaveBeenCalledTimes(2);
		expect(publish).toHaveBeenCalledTimes(2);
		expect(discovery.getSnapshot()).toBe(snapshot);
		stopBrowser();
		await vi.advanceTimersByTimeAsync(30000);
		expect(list).toHaveBeenCalledTimes(2);
		expect(discovery.getSnapshot()).toEqual([]);
	});

	it("retries failed routes independently and resolves ports again after they disappear", async () => {
		const list = vi.fn().mockResolvedValue([server(3000), server(5173)]);
		const publish = vi
			.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockImplementation(
				async (port: number) => `https://p${port}.chat.boxd.sh`,
			);
		const discovery = createPreviewDiscovery({ list, publish });
		const stop = discovery.subscribe(vi.fn());
		await flush();
		expect(discovery.getSnapshot()[1]?.publicUrl).toContain("p5173");
		await vi.advanceTimersByTimeAsync(5000);
		expect(publish.mock.calls).toEqual([[3000], [5173], [3000]]);
		list.mockResolvedValueOnce([server(5173)]);
		await vi.advanceTimersByTimeAsync(10000);
		expect(publish.mock.calls).toEqual([[3000], [5173], [3000], [3000]]);
		stop();
	});
	it("reports a detected port whose provider rejects publication, then clears the error on recovery", async () => {
		const publish = vi
			.fn()
			.mockRejectedValueOnce(new Error("provider-unavailable"))
			.mockResolvedValue("https://p3001.workspace.boxd.sh");
		const discovery = createPreviewDiscovery({
			list: async () => [server(3001)],
			publish,
		});
		const stop = discovery.subscribe(vi.fn());
		await flush();
		expect(discovery.getSnapshot()[0]).toMatchObject({
			port: 3001,
			publicationState: "failed",
		});
		await vi.advanceTimersByTimeAsync(5000);
		expect(discovery.getSnapshot()[0]).toMatchObject({
			publicUrl: "https://p3001.workspace.boxd.sh",
			publicationState: "ready",
		});
		stop();
	});

	it("does not overlap polls or publish late results after the last subscriber leaves", async () => {
		let finish!: (servers: ReadonlyArray<DiscoveredPreview>) => void;
		const list = vi.fn(
			() =>
				new Promise<ReadonlyArray<DiscoveredPreview>>((resolve) => {
					finish = resolve;
				}),
		);
		const publish = vi.fn();
		const idle = vi.fn();
		const discovery = createPreviewDiscovery({ list, publish, onIdle: idle });
		const stop = discovery.subscribe(vi.fn());
		await vi.advanceTimersByTimeAsync(30000);
		expect(list).toHaveBeenCalledTimes(1);
		stop();
		finish([server(3000)]);
		await flush();
		expect(publish).not.toHaveBeenCalled();
		expect(discovery.getSnapshot()).toEqual([]);
		expect(idle).toHaveBeenCalledOnce();
	});

	it("keeps the same port isolated between chats", async () => {
		const create = (chat: string) =>
			createPreviewDiscovery({
				list: async () => [server(3000)],
				publish: async (port) => `https://p${port}.${chat}.boxd.sh`,
			});
		const a = create("chat-a");
		const b = create("chat-b");
		const stopA = a.subscribe(vi.fn());
		const stopB = b.subscribe(vi.fn());
		await flush();
		expect(a.getSnapshot()[0]?.publicUrl).toBe("https://p3000.chat-a.boxd.sh");
		expect(b.getSnapshot()[0]?.publicUrl).toBe("https://p3000.chat-b.boxd.sh");
		stopA();
		stopB();
	});

	it("backs off disconnected discovery and recovers without remounting", async () => {
		const list = vi
			.fn()
			.mockRejectedValueOnce(new Error("disconnected"))
			.mockResolvedValue([server(3000)]);
		const discovery = createPreviewDiscovery({ list });
		const stop = discovery.subscribe(vi.fn());
		await vi.advanceTimersByTimeAsync(9999);
		expect(list).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(discovery.getSnapshot()).toEqual([server(3000)]);
		stop();
	});

	it("limits concurrent publication and drops pending work when the chat closes", async () => {
		const completions: Array<(url: string) => void> = [];
		const publish = vi.fn(
			() => new Promise<string>((resolve) => completions.push(resolve)),
		);
		const discovery = createPreviewDiscovery({
			list: async () => Array.from({ length: 12 }, (_, i) => server(3000 + i)),
			publish,
		});
		const stop = discovery.subscribe(vi.fn());
		await flush();
		expect(publish).toHaveBeenCalledTimes(4);

		expect(discovery.getSnapshot()).toHaveLength(12);
		stop();
		for (const complete of completions) complete("https://old.boxd.sh");
		await flush();
		expect(publish).toHaveBeenCalledTimes(4);
		expect(discovery.getSnapshot()).toEqual([]);
	});

	it("ignores a previous subscription's late URL after restarting discovery", async () => {
		let complete!: (url: string) => void;
		const publish = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<string>((resolve) => {
						complete = resolve;
					}),
			)
			.mockResolvedValue("https://new.boxd.sh");
		const discovery = createPreviewDiscovery({
			list: async () => [server(3000)],
			publish,
		});
		const stopOld = discovery.subscribe(vi.fn());
		await flush();
		stopOld();
		const stopNew = discovery.subscribe(vi.fn());
		await flush();
		complete("https://old.boxd.sh");
		await flush();
		expect(discovery.getSnapshot()[0]?.publicUrl).toBe("https://new.boxd.sh");
		stopNew();
	});
});
