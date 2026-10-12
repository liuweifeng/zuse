/**
 * Deterministic request id for the launch agent's first grant. Bound to the
 * workspace, runtime generation, enrolled recipient key, provider and grant
 * protocol, so a lost bootstrap response or a timed-out issuance replays the
 * same authority cache entry instead of a second refresh. RFC 9562 custom
 * (version 8) UUID derived from SHA-256; valid for the authority's UUID check.
 */
export const launchGrantRequestId = async (input: {
	readonly workspaceId: string;
	readonly runtimeGeneration: number;
	readonly keyThumbprint: string;
	readonly providerId: string;
	readonly protocolVersion: 1;
}): Promise<string> => {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(
				[
					"zuse-launch-grant",
					String(input.protocolVersion),
					input.workspaceId,
					String(input.runtimeGeneration),
					input.keyThumbprint,
					input.providerId,
				].join("\n"),
			),
		),
	);
	const bytes = digest.slice(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = [...bytes]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
