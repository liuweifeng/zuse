import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const uploads = new Map<string, Buffer[]>();
const files = new Map<
	string,
	{ bytes: string; mimeType: string; originalName: string }
>();
const fixtureSession = {
	id: "native-fixture",
	projectId: "fixture-project",
	title: "Fixture conversation",
	providerId: "fixture",
	model: "fixture",
	worktreeId: null,
};
const server = Bun.serve<{ timeline?: string; version: number }>({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request, server) {
		if (server.upgrade(request, { data: { version: 0 } })) return;
		return new Response("WebSocket required", { status: 426 });
	},
	websocket: {
		message(socket, raw) {
			const frame = JSON.parse(String(raw));
			if (frame._tag !== "Request") return;
			if (process.env.ZUSE_FIXTURE_DIAGNOSTICS) console.log(frame.tag);
			const reply = (value: unknown) =>
				socket.send(
					JSON.stringify({
						_tag: "Exit",
						requestId: frame.id,
						exit: { _tag: "Success", value },
					}),
				);
			if (frame.tag === "connect.handshake") reply({ protocolVersion: 7 });
			else if (frame.tag === "workspace.list")
				reply([{ id: "fixture-project", name: "Fixture project" }]);
			else if (frame.tag === "session.list") reply([fixtureSession]);
			else if (frame.tag === "session.get") reply(fixtureSession);
			else if (frame.tag === "session.events") {
				socket.data.timeline = frame.id;
				socket.send(
					JSON.stringify({
						_tag: "Chunk",
						requestId: frame.id,
						values: [
							{
								kind: "snapshot",
								sessionId: fixtureSession.id,
								throughVersion: 0,
								cursor: { epoch: "fixture", version: 0 },
								projection: { messages: [], status: "idle", interactions: [] },
							},
							{
								kind: "synchronized",
								sessionId: fixtureSession.id,
								throughVersion: 0,
							},
						],
					}),
				);
			} else if (frame.tag === "session.events.head")
				reply({ throughVersion: socket.data.version, streamEpoch: "fixture" });
			else if (frame.tag === "messages.send") {
				const p = frame.payload;
				const text = p.text ?? p.input?.text ?? "";
				const values = [
					{
						id: p.clientMessageId,
						role: "user",
						content: { _tag: "user", text },
					},
					{
						id: crypto.randomUUID(),
						role: "assistant",
						content: { _tag: "assistant", text: `Received: ${text}` },
					},
				].map((message) => ({
					kind: "event",
					sessionId: fixtureSession.id,
					streamVersion: ++socket.data.version,
					event: {
						_tag: "MessagePersisted",
						message: {
							...message,
							sessionId: fixtureSession.id,
							createdAt: new Date().toISOString(),
						},
					},
				}));
				socket.send(
					JSON.stringify({
						_tag: "Chunk",
						requestId: socket.data.timeline,
						values,
					}),
				);
				reply(null);
			} else if (frame.tag === "git.reviewPatches") {
				socket.send(
					JSON.stringify({
						_tag: "Chunk",
						requestId: frame.id,
						values: [
							{
								path: "example.swift",
								result: {
									mode: "text",
									patch:
										"--- a/example.swift\n+++ b/example.swift\n@@ -1 +1 @@\n-let value = 1\n+let value = 2",
									truncated: false,
									bytes: 100,
								},
								error: null,
							},
						],
					}),
				);
				reply(null);
			} else if (
				frame.tag === "attachments.upload" ||
				frame.tag === "attachments.uploadChunk"
			) {
				const p = frame.payload;
				const id = p.uploadId ?? crypto.randomUUID();
				const chunks = uploads.get(id) ?? [];
				const bytes = Buffer.from(p.bytes, "base64");
				if (
					p.offset !== undefined &&
					p.offset !== chunks.reduce((n, c) => n + c.length, 0)
				)
					throw new Error("Unexpected chunk offset");
				chunks.push(bytes);
				uploads.set(id, chunks);
				const size = chunks.reduce((n, c) => n + c.length, 0);
				if (p.totalBytes !== undefined && size < p.totalBytes) reply(null);
				else {
					files.set(id, {
						bytes: Buffer.concat(chunks).toString("base64"),
						mimeType: p.mimeType,
						originalName: p.originalName,
					});
					uploads.delete(id);
					reply({
						id,
						mimeType: p.mimeType,
						originalName: p.originalName,
						sizeBytes: size,
					});
				}
			} else if (frame.tag === "attachments.read")
				reply(files.get(frame.payload.id));
			else if (frame.tag === "fixture.echo") reply(frame.payload);
			else if (frame.tag === "fixture.stream") {
				socket.send(
					JSON.stringify({
						_tag: "Chunk",
						requestId: frame.id,
						values: [1, 2, 3],
					}),
				);
				reply(null);
			} else if (frame.tag === "fixture.failure") {
				socket.send(
					JSON.stringify({
						_tag: "Exit",
						requestId: frame.id,
						exit: {
							_tag: "Failure",
							cause: [
								{ _tag: "Fail", error: { message: "Expected rejection" } },
							],
						},
					}),
				);
			} else if (frame.tag === "fixture.close") socket.close();
		},
	},
});
writeFileSync(
	process.env.ZUSE_FIXTURE_PORT_FILE ??
		resolve(import.meta.dir, "../.build/rpc-port"),
	String(server.port),
);
