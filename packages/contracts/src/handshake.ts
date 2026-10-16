import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

export const WIRE_PROTOCOL_VERSION = 7 as const;
export const MIN_SUPPORTED_WIRE_PROTOCOL_VERSION = 7 as const;

export class WireHello extends Schema.Class<WireHello>("WireHello")({
	protocolVersion: Schema.Number,
}) {}

export class WireWelcome extends Schema.Class<WireWelcome>("WireWelcome")({
	workspaceScopeProtocol: Schema.optional(Schema.Literal(1)),
	protocolVersion: Schema.Number,
}) {}

export class WireProtocolRejected extends Schema.TaggedErrorClass<WireProtocolRejected>()(
	"WireProtocolRejected",
	{
		expectedVersion: Schema.Number,
		receivedVersion: Schema.Number,
	},
) {
	override get message() {
		return `Update required: this runtime uses protocol ${this.expectedVersion}, but this app uses ${this.receivedVersion}. Update Zuse or the workspace runtime before reconnecting.`;
	}
}

export const ConnectHandshakeRpc = Rpc.make("connect.handshake", {
	payload: WireHello,
	success: WireWelcome,
	error: WireProtocolRejected,
});
