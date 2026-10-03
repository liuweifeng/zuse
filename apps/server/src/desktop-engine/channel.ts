import type { Socket } from "node:net";
import { Schema } from "effect";

export const LOCAL_ENGINE_PROTOCOL = 1;
const Frame = Schema.Union([
	Schema.TaggedStruct("Hello", {
		token: Schema.String,
		version: Schema.Number,
		host: Schema.Boolean,
		authRedirectUri: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("Welcome", { version: Schema.Number }),
	Schema.TaggedStruct("Rpc", { payload: Schema.String }),
	Schema.TaggedStruct("HostRequest", {
		id: Schema.String,
		method: Schema.Literals(["pickFolder", "openExternal"]),
		payload: Schema.Unknown,
	}),
	Schema.TaggedStruct("HostResult", {
		id: Schema.String,
		value: Schema.Unknown,
		error: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("HostEvent", {
		name: Schema.Literals(["openSession", "pairingRequest", "diagnostic"]),
		payload: Schema.Unknown,
	}),
	Schema.TaggedStruct("HostCallback", {
		flow: Schema.Literal("account"),
		url: Schema.String,
	}),
	Schema.TaggedStruct("Ping", {}),
	Schema.TaggedStruct("Pong", {}),
]);
export type EngineFrame = typeof Frame.Type;
const decode = Schema.decodeUnknownSync(Frame);
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

export interface EngineChannel {
	readonly send: (frame: EngineFrame) => boolean;
	readonly close: () => void;
	readonly authenticated: () => void;
	readonly closed: Promise<void>;
}

/** Length framing preserves UTF-8 boundaries and bounds both partial input and slow output. */
export const makeEngineChannel = (
	socket: Socket,
	receive: (frame: EngineFrame) => void,
): EngineChannel => {
	let limit = 4 * 1024;
	const header = Buffer.alloc(4);
	let headerLength = 0;
	let body: Buffer | null = null,
		bodyLength = 0;
	let closed = false;
	let resolveClosed = () => {};
	const closedPromise = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	const close = () => {
		socket.destroy();
	};
	socket.setNoDelay(true);
	socket.on("error", close);
	socket.once("close", () => {
		closed = true;
		body = null;
		resolveClosed();
	});
	socket.on("data", (chunk: Buffer) => {
		try {
			let offset = 0;
			while (offset < chunk.length && !socket.destroyed) {
				if (body === null) {
					const length = Math.min(4 - headerLength, chunk.length - offset);
					chunk.copy(header, headerLength, offset, offset + length);
					headerLength += length;
					offset += length;
					if (headerLength !== 4) continue;
					const size = header.readUInt32BE();
					if (size === 0 || size > limit) {
						close();
						return;
					}
					body = Buffer.allocUnsafe(size);
					bodyLength = 0;
					headerLength = 0;
				}
				const length = Math.min(
					body.length - bodyLength,
					chunk.length - offset,
				);
				chunk.copy(body, bodyLength, offset, offset + length);
				bodyLength += length;
				offset += length;
				if (bodyLength === body.length) {
					const value = decode(JSON.parse(body.toString("utf8")));
					body = null;
					bodyLength = 0;
					receive(value);
				}
			}
		} catch {
			close();
		}
	});
	return {
		closed: closedPromise,
		close,
		authenticated: () => {
			limit = MAX_FRAME_BYTES;
		},
		send: (frame) => {
			if (closed || socket.destroyed) return false;
			const payload = Buffer.from(JSON.stringify(frame));
			if (
				payload.length > MAX_FRAME_BYTES ||
				socket.writableLength + payload.length + 4 > MAX_QUEUED_BYTES
			) {
				close();
				return false;
			}
			const length = Buffer.allocUnsafe(4);
			length.writeUInt32BE(payload.length);
			socket.cork();
			socket.write(length);
			socket.write(payload);
			socket.uncork();
			return true;
		},
	};
};
