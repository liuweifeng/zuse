import { makeRpcClientSession } from "@zuse/client-runtime/connection";
import { Effect, Layer, Schema } from "effect";
import { Rpc, RpcGroup, RpcSerialization } from "effect/unstable/rpc";
import { expect, it } from "vitest";
import type { RpcBridge } from "../../src/lib/bridge.ts";
import { electronClientProtocolLayer } from "../../src/lib/electron-client-protocol.ts";

const Rpcs = RpcGroup.make(
	Rpc.make("read", { payload: Schema.Struct({}), success: Schema.String }),
);
const fixture = () => {
	let activeId = "";
	let disconnect: (id: string) => void = () => {};
	let receive: (frame: string | Uint8Array) => void = () => {};
	let closes = 0;
	const sent: Array<{ id: string | undefined; frame: string | Uint8Array }> =
		[];
	const detached: string[] = [];
	const bridge: RpcBridge = {
		connect: async (id) => {
			activeId = id;
		},
		disconnect: (id) => {
			detached.push(id);
		},
		onDisconnect: (handler) => {
			disconnect = handler;
			return () => {
				disconnect = () => {};
			};
		},
		onMessage: (handler, id) => {
			expect(id).toBe(activeId);
			receive = handler;
			return () => {
				receive = () => {};
			};
		},
		send: (frame, id) => {
			sent.push({ id, frame });
		},
	};
	return {
		bridge,
		sent,
		detached,
		id: () => activeId,
		closes: () => closes,
		lose: (id: string) => disconnect(id),
		reply: (frame: unknown) => receive(JSON.stringify(frame)),
		make: () =>
			makeRpcClientSession(
				electronClientProtocolLayer(bridge, () => {
					closes++;
				}).pipe(Layer.provide(RpcSerialization.layerJson)),
				Rpcs,
			),
	};
};

it("fails pending RPCs and notifies reconnect on engine loss without replay", async () => {
	const f = fixture();
	const session = await f.make();
	try {
		const pending = Effect.runPromise(Effect.exit(session.client.read({})));
		await expect.poll(() => f.sent.length).toBe(1);
		const id = f.id();
		expect(f.sent[0]?.id).toBe(id);
		f.lose("previous attachment");
		expect(f.closes()).toBe(0);
		f.lose(id);
		expect((await pending)._tag).toBe("Failure");
		await expect.poll(() => f.closes()).toBe(1);
		f.lose(id);
		await expect(Effect.runPromise(session.client.read({}))).rejects.toThrow();
		expect(f.sent).toHaveLength(1);
		expect(f.closes()).toBe(1);
	} finally {
		await session.dispose();
	}
	expect(f.detached).toEqual([f.id()]);
	const old = f.id();
	const replacement = await f.make();
	try {
		expect(f.id()).not.toBe(old);
		f.lose(old);
		expect(f.closes()).toBe(1);
		const pending = Effect.runPromise(replacement.client.read({}));
		await expect.poll(() => f.sent.length).toBe(2);
		const sent = f.sent[1];
		if (sent === undefined || typeof sent.frame !== "string")
			throw new Error("missing request");
		const request = JSON.parse(sent.frame);
		f.reply({
			_tag: "Exit",
			requestId: request.id,
			exit: { _tag: "Success", value: "recovered" },
		});
		expect(await pending).toBe("recovered");
	} finally {
		await replacement.dispose();
	}
});

it("cleans up an attachment rejected during connection setup", async () => {
	const f = fixture();
	const bridge: RpcBridge = {
		...f.bridge,
		connect: async (id) => {
			await f.bridge.connect?.(id);
			f.lose(id);
			throw new Error("closed during open");
		},
	};
	await expect(
		makeRpcClientSession(
			electronClientProtocolLayer(bridge).pipe(
				Layer.provide(RpcSerialization.layerJson),
			),
			Rpcs,
		),
	).rejects.toThrow();
	expect(f.detached).toEqual([f.id()]);
	expect(f.sent).toEqual([]);
});
