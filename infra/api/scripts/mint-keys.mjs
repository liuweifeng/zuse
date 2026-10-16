import { exportJWK, generateKeyPair } from "jose";

const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
	extractable: true,
});

console.log("PUBLIC (API_MINT_PUBLIC_JWK):");
console.log(JSON.stringify(await exportJWK(publicKey)));
console.log("");
console.log("PRIVATE (wrangler secret put RELAY_MINT_PRIVATE_JWK):");
console.log(JSON.stringify(await exportJWK(privateKey)));
