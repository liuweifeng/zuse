import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { assertRuntimeCompatibility } from "./runtime-deploy-compatibility.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicJwk = JSON.stringify(publicKey.export({ format: "jwk" }));
function signed(min, max) {
	const manifest = { wireProtocol: { min, max } };
	return {
		...manifest,
		signature: sign(
			null,
			Buffer.from(JSON.stringify(manifest)),
			privateKey,
		).toString("base64url"),
	};
}
test("blocks protocol 6 API deployment while production publishes protocol 5", () => {
	assert.throws(
		() => assertRuntimeCompatibility(signed(5, 5), publicJwk, 6),
		/Publish a compatible signed production runtime/,
	);
});
test("allows compatible signed runtimes", () => {
	assertRuntimeCompatibility(signed(6, 6), publicJwk, 6);
	assertRuntimeCompatibility(signed(5, 6), publicJwk, 6);
});
test("rejects tampering even when the protocol looks compatible", () => {
	assert.throws(
		() =>
			assertRuntimeCompatibility(
				{ ...signed(5, 5), wireProtocol: { min: 6, max: 6 } },
				publicJwk,
				6,
			),
		/signature is invalid/,
	);
});

test("blocks engine protocol 7 promotion while production publishes legacy session contracts", () => {
	assert.throws(
		() => assertRuntimeCompatibility(signed(5, 6), publicJwk, 7),
		/Publish a compatible signed production runtime/,
	);
	assertRuntimeCompatibility(signed(7, 7), publicJwk, 7);
});
