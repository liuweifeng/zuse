import { AgentSessionId, CommandId, MemoizeRpcs } from "@zuse/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	getClientProtocolVersion,
	makeRpcClientSession,
} from "../../src/connection.ts";
import { normalizeLegacyRuntimeResponse } from "../../src/legacy-runtime-response.ts";
import { wsClientProtocolLayer } from "../../src/ws-protocol.ts";

const legacySession = {
	id: "session-old",
	projectId: "project-old",
	title: "Existing chat",
	titleProvenance: "manual",
	providerId: "codex",
	model: "gpt-5",
	status: "running",
	archivedAt: null,
	cursor: "original-provider-conversation",
	resumeStrategy: "codex-thread-id",
	runtimeMode: "approval-required",
	worktreeId: null,
	chatId: "chat-old",
	forkedFromSessionId: null,
	forkedFromMessageId: null,
	permissionMode: "default",
	toolSearch: false,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-02T00:00:00.000Z",
};
const snapshot = {
	kind: "snapshot",
	sessionId: "session-old",
	throughVersion: 10,
	cursor: { epoch: "old-db", version: 10 },
	projection: {
		messages: [],
		status: "running",
		currentTurn: { turnId: "actual-turn", phase: "running" },
		queue: { items: [], paused: false },
		permissionMode: "default",
		runtimeMode: "approval-required",
		interactions: [],
	},
};

type Request = {
	_tag: string;
	id: string;
	tag: string;
	payload: Record<string, unknown>;
};

/** The guest speaks encoded historical contracts; the app uses its real JSON RPC stack. */
class LegacySocket extends EventTarget {
	readyState = 0;
	binaryType = "arraybuffer";
	dropSendResponse = false;
	readonly requests: Request[] = [];
	constructor(readonly version: number) {
		super();
		setTimeout(() => {
			this.readyState = 1;
			this.dispatchEvent(new Event("open"));
		}, 0);
	}
	close() {
		this.readyState = 3;
		this.dispatchEvent(new CloseEvent("close", { code: 1000, wasClean: true }));
	}
	send(data: string) {
		const requests = JSON.parse(data);
		for (const request of Array.isArray(requests) ? requests : [requests]) {
			if (request._tag === "Ping") {
				this.reply({ _tag: "Pong" });
				continue;
			}
			if (request._tag !== "Request") continue;
			this.requests.push(request);
			const success = (value: unknown) =>
				this.reply({
					_tag: "Exit",
					requestId: request.id,
					exit: { _tag: "Success", value },
				});
			if (request.tag === "connect.handshake") {
				if (request.payload.protocolVersion !== this.version)
					this.reply({
						_tag: "Exit",
						requestId: request.id,
						exit: {
							_tag: "Failure",
							cause: [
								{
									_tag: "Fail",
									error: {
										_tag: "WireProtocolRejected",
										expectedVersion: this.version,
										receivedVersion: request.payload.protocolVersion,
									},
								},
							],
						},
					});
				else
					success({ protocolVersion: this.version, workspaceScopeProtocol: 1 });
			} else if (request.tag === "session.get") success(legacySession);
			else if (request.tag === "session.events") {
				this.reply({
					_tag: "Chunk",
					requestId: request.id,
					values: [
						snapshot,
						{
							kind: "event",
							sessionId: "session-old",
							streamVersion: 11,
							eventId: "settled",
							event: {
								_tag: "TurnSettled",
								turnId: "actual-turn",
								outcome: "completed",
							},
						},
					],
				});
				success(null);
			} else if (request.tag === "messages.interrupt")
				success({ _tag: "requested", turnId: request.payload.expectedTurnId });
			else if (request.tag === "messages.send") {
				if (this.dropSendResponse) queueMicrotask(() => this.close());
				else success(null);
			} else throw new Error(`Unexpected RPC ${request.tag}`);
		}
	}
	private reply(value: unknown) {
		queueMicrotask(() =>
			this.dispatchEvent(
				new MessageEvent("message", { data: JSON.stringify(value) }),
			),
		);
	}
}

describe("retained runtime serialized transport", () => {
	it.each([
		5, 6,
	])("opens protocol %s history, streams and writes without replay", async (version) => {
		let negotiated = 7;
		const socket = new LegacySocket(version);
		const session = await makeRpcClientSession(
			wsClientProtocolLayer("wss://gateway.example/rpc?wireVersion=7", {
				makeWebSocket: () => socket as unknown as WebSocket,
				transformResponse: (value) =>
					negotiated < 7 ? normalizeLegacyRuntimeResponse(value) : value,
			}),
			MemoizeRpcs,
			{
				protocolVersion: 7,
				allowLegacyCloud: true,
				onNegotiated: (value) => {
					negotiated = value;
				},
				perform: (client, hello) => client["connect.handshake"](hello),
			},
		);
		try {
			expect(getClientProtocolVersion(session.client)).toBe(version);
			const sessionId = AgentSessionId.make("session-old");
			const existing = await Effect.runPromise(
				session.client["session.get"]({ sessionId }),
			);
			expect(existing.providerThread).toBeNull();
			const frames = await Effect.runPromise(
				session.client["session.events"]({ sessionId }).pipe(Stream.runCollect),
			);
			expect(frames[0]).toMatchObject({
				projection: { activeTurn: { id: "actual-turn" } },
			});
			expect(frames[1]).toMatchObject({
				event: { _tag: "TurnSettled", turnId: "actual-turn" },
			});
			const first = frames[0];
			if (first?.kind !== "snapshot" || !first.projection.activeTurn)
				throw new Error("Expected active turn");
			await Effect.runPromise(
				session.client["messages.interrupt"]({
					commandId: CommandId.make("stop-once"),
					sessionId,
					expectedTurnId: first.projection.activeTurn.id,
				}),
			);
			await Effect.runPromise(
				session.client["messages.send"]({
					commandId: CommandId.make("send-once"),
					sessionId,
					text: "Continue existing conversation",
				}),
			);
			expect(socket.requests.map((request) => request.tag)).toEqual([
				"connect.handshake",
				"connect.handshake",
				"session.get",
				"session.events",
				"messages.interrupt",
				"messages.send",
			]);
			expect(socket.requests[4]?.payload.expectedTurnId).toBe("actual-turn");
			socket.dropSendResponse = true;
			await expect(
				Effect.runPromise(
					session.client["messages.send"]({
						commandId: CommandId.make("uncertain-send"),
						sessionId,
						text: "Disconnect after acceptance",
					}),
				),
			).rejects.toBeDefined();
			expect(
				socket.requests.filter(
					(request) => request.payload.commandId === "uncertain-send",
				),
			).toHaveLength(1);
			expect(
				socket.requests.filter(
					(request) => request.tag === "connect.handshake",
				),
			).toHaveLength(2);
		} finally {
			await session.dispose();
		}
		expect(socket.readyState).toBe(3);
	});
});
