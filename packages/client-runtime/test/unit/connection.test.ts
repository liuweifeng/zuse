import {
	ConnectHandshakeRpc,
	RpcAccessDeniedError,
	WireProtocolRejected,
} from "@zuse/contracts";
import { Context, Effect, Layer } from "effect";
import { RpcClient, RpcGroup } from "effect/unstable/rpc";
import { describe, expect, test } from "vitest";

import { cloudFailurePresentation } from "../../src/cloud-failure-presentation.ts";
import {
	isRpcCredentialExpired,
	makeManagedClientSession,
	makeRpcClientSession,
	validateProtocolVersion,
	WireProtocolMismatchError,
} from "../../src/connection.js";

class Value extends Context.Service<Value, number>()("test/Value") {}

describe("managed client session", () => {
	test("renews expired credentials but never retries a denied permission", () => {
		expect(
			isRpcCredentialExpired(
				new RpcAccessDeniedError({ code: "credential-expired" }),
			),
		).toBe(true);
		expect(
			isRpcCredentialExpired(
				new RpcAccessDeniedError({ code: "access-denied" }),
			),
		).toBe(false);
		expect(isRpcCredentialExpired({ code: "credential-expired" })).toBe(false);
	});
	test("rejects a mismatched wire protocol version", async () => {
		await expect(
			Effect.runPromise(validateProtocolVersion(2, 1)),
		).rejects.toMatchObject({
			_tag: "WireProtocolMismatchError",
			expectedVersion: 2,
			receivedVersion: 1,
		});
	});
	test("provides the protocol layer and releases it exactly once", async () => {
		let releases = 0;
		const layer = Layer.effect(
			Value,
			Effect.acquireRelease(Effect.succeed(42), () =>
				Effect.sync(() => releases++),
			),
		);
		const session = await makeManagedClientSession(layer, () => Value);

		expect(session.client).toBe(42);
		await session.dispose();
		expect(releases).toBe(1);
	});

	test("releases the runtime when client construction fails", async () => {
		let releases = 0;
		const layer = Layer.effect(
			Value,
			Effect.acquireRelease(Effect.succeed(42), () =>
				Effect.sync(() => releases++),
			),
		);

		await expect(
			makeManagedClientSession(layer, () => Effect.fail(new Error("boom"))),
		).rejects.toThrow("boom");
		expect(releases).toBe(1);
	});
});

test.each([
	new WireProtocolRejected({ expectedVersion: 6, receivedVersion: 7 }),
	new WireProtocolMismatchError({ expectedVersion: 7, receivedVersion: 6 }),
])("presents incompatible RPC contracts as an update requirement", (cause) => {
	expect(cause.message).toContain("Update required");
	expect(cloudFailurePresentation({ cause })?.kind).toBe("update-required");
});

test("decodes a retained runtime's encoded handshake rejection before opening resources", async () => {
	const protocol = Layer.effect(
		RpcClient.Protocol,
		RpcClient.Protocol.make((write) =>
			Effect.succeed({
				supportsAck: false,
				supportsTransferables: false,
				send: (clientId, request) =>
					request._tag === "Request"
						? write(clientId, {
								_tag: "Exit",
								requestId: request.id,
								exit: {
									_tag: "Failure",
									cause: [
										{
											_tag: "Fail",
											error: {
												_tag: "WireProtocolRejected",
												expectedVersion: 6,
												receivedVersion: 7,
											},
										},
									],
								},
							})
						: Effect.void,
			}),
		),
	);
	const group = RpcGroup.make(ConnectHandshakeRpc);
	await expect(
		makeRpcClientSession(protocol, group, {
			protocolVersion: 7,
			perform: (client, hello) => client["connect.handshake"](hello),
		}),
	).rejects.toMatchObject({
		_tag: "WireProtocolRejected",
		expectedVersion: 6,
		receivedVersion: 7,
	});
});
