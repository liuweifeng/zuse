import {
	ConnectHandshakeRpc,
	RpcAccessDeniedError,
	WireProtocolRejected,
} from "@zuse/contracts";
import { Context, Effect, Layer } from "effect";
import { RpcClient, RpcGroup } from "effect/unstable/rpc";
import { describe, expect, test, vi } from "vitest";

import { cloudFailurePresentation } from "../../src/cloud-failure-presentation.ts";
import {
	getClientProtocolVersion,
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

const retainedProtocol = (
	version: number,
	sent: unknown[],
	releases: () => void,
) =>
	Layer.effect(
		RpcClient.Protocol,
		Effect.gen(function* () {
			yield* Effect.addFinalizer(() => Effect.sync(releases));
			return yield* RpcClient.Protocol.make((write) =>
				Effect.succeed({
					supportsAck: false,
					supportsTransferables: false,
					send: (clientId, request) => {
						if (request._tag !== "Request") return Effect.void;
						sent.push(request.payload);
						const hello = request.payload as { protocolVersion: number };
						return write(clientId, {
							_tag: "Exit",
							requestId: request.id,
							exit:
								hello.protocolVersion === version
									? {
											_tag: "Success",
											value: {
												protocolVersion: version,
												workspaceScopeProtocol: 1,
											},
										}
									: {
											_tag: "Failure",
											cause: [
												{
													_tag: "Fail",
													error: {
														_tag: "WireProtocolRejected",
														expectedVersion: version,
														receivedVersion: hello.protocolVersion,
													},
												},
											],
										},
						});
					},
				}),
			);
		}),
	);

describe("retained cloud handshake negotiation", () => {
	test.each([
		5, 6,
	])("negotiates protocol %s before exposing a client", async (version) => {
		const sent: unknown[] = [];
		let negotiated: number | undefined;
		let releases = 0;
		const session = await makeRpcClientSession(
			retainedProtocol(version, sent, () => {
				releases++;
			}),
			RpcGroup.make(ConnectHandshakeRpc),
			{
				protocolVersion: 7,
				allowLegacyCloud: true,
				onNegotiated: (value) => {
					negotiated = value;
				},
				perform: (client, hello) => client["connect.handshake"](hello),
			},
		);
		expect(sent).toEqual([
			{ protocolVersion: 7 },
			{ protocolVersion: version },
		]);
		expect(negotiated).toBe(version);
		expect(getClientProtocolVersion(new Proxy(session.client, {}))).toBe(
			version,
		);
		expect(releases).toBe(0);
		await session.dispose();
		expect(releases).toBe(1);
	});

	test.each([
		{ version: 6, allowLegacyCloud: false },
		{ version: 4, allowLegacyCloud: true },
		{ version: 8, allowLegacyCloud: true },
	])("keeps strict or unsupported protocols closed: %j", async ({
		version,
		allowLegacyCloud,
	}) => {
		const sent: unknown[] = [];
		let releases = 0;
		await expect(
			makeRpcClientSession(
				retainedProtocol(version, sent, () => {
					releases++;
				}),
				RpcGroup.make(ConnectHandshakeRpc),
				{
					protocolVersion: 7,
					allowLegacyCloud,
					perform: (client, hello) => client["connect.handshake"](hello),
				},
			),
		).rejects.toMatchObject({ _tag: "WireProtocolRejected" });
		expect(sent).toEqual([{ protocolVersion: 7 }]);
		expect(releases).toBe(1);
	});
});

test("times out a silent runtime handshake and releases its transport", async () => {
	vi.useFakeTimers();
	let releases = 0;
	let requests = 0;
	let finishHandshake = () => {};
	let requestSent = () => {};
	const sent = new Promise<void>((resolve) => {
		requestSent = resolve;
	});
	const protocol = Layer.effect(
		RpcClient.Protocol,
		Effect.gen(function* () {
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					releases++;
				}),
			);
			return yield* RpcClient.Protocol.make((write) =>
				Effect.succeed({
					supportsAck: false,
					supportsTransferables: false,
					send: (clientId, request) =>
						Effect.gen(function* () {
							if (request._tag !== "Request") return;
							requests++;
							finishHandshake = () => {
								void Effect.runPromise(
									write(clientId, {
										_tag: "Exit",
										requestId: request.id,
										exit: { _tag: "Success", value: { protocolVersion: 7 } },
									}),
								);
							};
							requestSent();
						}),
				}),
			);
		}),
	);
	let failure: unknown;
	const pending = makeRpcClientSession(
		protocol,
		RpcGroup.make(ConnectHandshakeRpc),
		{
			protocolVersion: 7,
			allowLegacyCloud: true,
			perform: (client, hello) => client["connect.handshake"](hello),
		},
	).then(
		async (session) => {
			await session.dispose();
		},
		(cause) => {
			failure = cause;
		},
	);
	try {
		await sent;
		await vi.advanceTimersByTimeAsync(30_001);
		expect(failure).toMatchObject({ _tag: "TimeoutError" });
		expect(requests).toBe(1);
		expect(releases).toBe(1);
	} finally {
		finishHandshake();
		await pending;
		vi.useRealTimers();
	}
});
