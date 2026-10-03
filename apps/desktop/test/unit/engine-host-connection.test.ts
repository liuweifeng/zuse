import type {
	connectLocalEngine,
	EngineChannel,
	EngineFrame,
} from "@zusehq/server/desktop-engine";
import { expect, it } from "vitest";
import { connectEngineHost } from "../../src/engine-host-connection.ts";

const fixture = (
	request: Parameters<typeof connectEngineHost>[0]["request"],
) => {
	const attachments: Array<{
		channel: EngineChannel;
		receive: Parameters<typeof connectLocalEngine>[1]["receive"];
		sent: EngineFrame[];
	}> = [];
	const events: EngineFrame[] = [];
	const host = connectEngineHost({
		endpoint: async () => ({
			version: 1,
			token: "t".repeat(64),
			port: 1,
			apiPort: 2,
			pid: 3,
			appVersion: "test",
		}),
		authRedirectUri: () => "http://localhost:8976/callback",
		request,
		event: (event) => {
			events.push(event);
		},
		retryMs: 1,
		connect: async (_, options) => {
			let finish = () => {};
			const sent: EngineFrame[] = [];
			let closed = false;
			const channel: EngineChannel = {
				closed: new Promise<void>((resolve) => {
					finish = resolve;
				}),
				close: () => {
					closed = true;
					finish();
				},
				authenticated: () => {},
				send: (frame) => {
					if (closed) return false;
					sent.push(frame);
					return true;
				},
			};
			attachments.push({ channel, receive: options.receive, sent });
			return channel;
		},
	});
	return { host, attachments, events };
};

it("fences late native responses and callbacks across engine replacement", async () => {
	let resolve: (value: unknown) => void = () => {};
	let signal: AbortSignal | undefined;
	let calls = 0;
	const f = fixture((_, value) => {
		calls++;
		signal = value;
		return new Promise((done) => {
			resolve = done;
		});
	});
	try {
		await expect.poll(() => f.attachments.length).toBe(1);
		const first = f.attachments[0];
		first?.receive({
			_tag: "HostRequest",
			id: "folder",
			method: "pickFolder",
			payload: null,
		});
		await expect.poll(() => calls).toBe(1);
		first?.channel.close();
		await expect.poll(() => f.attachments.length).toBe(2);
		expect(signal?.aborted).toBe(true);
		resolve("/old/folder");
		await Promise.resolve();
		await Promise.resolve();
		expect(f.attachments[1]?.sent).toEqual([]);
		expect(calls).toBe(1);
		first?.receive({
			_tag: "HostEvent",
			name: "openSession",
			payload: "stale",
		});
		expect(f.events).toEqual([]);
		expect(f.host.callback("http://localhost:8976/callback?code=new")).toBe(
			true,
		);
		expect(f.attachments[1]?.sent).toEqual([
			{
				_tag: "HostCallback",
				flow: "account",
				url: "http://localhost:8976/callback?code=new",
			},
		]);
	} finally {
		await f.host.close();
	}
	expect(f.host.callback("late")).toBe(false);
});

it("sanitizes native failures and stops reconnecting after desktop exit", async () => {
	const f = fixture(async () => {
		throw new Error("private native detail");
	});
	try {
		await expect.poll(() => f.attachments.length).toBe(1);
		f.attachments[0]?.receive({
			_tag: "HostRequest",
			id: "auth",
			method: "openExternal",
			payload: "https://example.com",
		});
		await expect.poll(() => f.attachments[0]?.sent.length).toBe(1);
		expect(f.attachments[0]?.sent).toEqual([
			{
				_tag: "HostResult",
				id: "auth",
				value: null,
				error: "The desktop could not complete this action.",
			},
		]);
	} finally {
		await f.host.close();
	}
	expect(f.attachments.length).toBe(1);
});

it("cancels an expired native request without discarding other actions", async () => {
	let signal: AbortSignal | undefined;
	let finish: (value: unknown) => void = () => {};
	const f = fixture((request, abort) => {
		if (request.id !== "expired") return Promise.resolve("/new/folder");
		signal = abort;
		return new Promise((resolve) => {
			finish = resolve;
		});
	});
	try {
		await expect.poll(() => f.attachments.length).toBe(1);
		const first = f.attachments[0];
		first?.receive({
			_tag: "HostRequest",
			id: "expired",
			method: "pickFolder",
			payload: null,
		});
		await expect.poll(() => signal !== undefined).toBe(true);
		first?.receive({ _tag: "HostCancel", id: "expired" });
		expect(signal?.aborted).toBe(true);
		first?.receive({
			_tag: "HostRequest",
			id: "new",
			method: "pickFolder",
			payload: null,
		});
		finish("/expired/folder");
		await expect.poll(() => first?.sent.length).toBe(1);
		expect(first?.sent).toEqual([
			{ _tag: "HostResult", id: "new", value: "/new/folder", error: undefined },
		]);
		expect(f.attachments.length).toBe(1);
	} finally {
		await f.host.close();
	}
});
