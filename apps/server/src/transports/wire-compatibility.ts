import {
	MIN_SUPPORTED_WIRE_PROTOCOL_VERSION,
	WIRE_PROTOCOL_VERSION,
	WireProtocolRejected,
	WireWelcome,
} from "@zuse/contracts";
import { Effect } from "effect";

export const supportsWireProtocol = (version: number): boolean =>
	Number.isInteger(version) &&
	version >= MIN_SUPPORTED_WIRE_PROTOCOL_VERSION &&
	version <= WIRE_PROTOCOL_VERSION;

export const acceptWireHandshake = (protocolVersion: number) =>
	supportsWireProtocol(protocolVersion)
		? Effect.succeed(
				WireWelcome.make({ protocolVersion, workspaceScopeProtocol: 1 }),
			)
		: Effect.fail(
				new WireProtocolRejected({
					expectedVersion: WIRE_PROTOCOL_VERSION,
					receivedVersion: protocolVersion,
				}),
			);
