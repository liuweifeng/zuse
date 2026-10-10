import { Effect } from "effect";
import { expect, it } from "vitest";
import { acceptWireHandshake } from "../../src/transports/wire-compatibility.ts";

it.each([
	7,
])("accepts and echoes the engine protocol %i", async (protocolVersion) => {
	expect(await Effect.runPromise(acceptWireHandshake(protocolVersion))).toEqual(
		{ protocolVersion, workspaceScopeProtocol: 1 },
	);
});
it.each([
	0,
	4,
	5,
	6,
	8,
	5.5,
	NaN,
])("rejects unsupported protocol %s", async (version) => {
	const error = await Effect.runPromise(
		Effect.flip(acceptWireHandshake(version)),
	);
	expect(error._tag).toBe("WireProtocolRejected");
	expect(error.message).toContain("Update required");
});
