/** Canonical JSON for immutable definitions; never used to reorder history. */
export function canonicalJson(
	value: unknown,
	options: { readonly legacyFingerprintV1?: boolean } = {},
): string {
	const legacy = options.legacyFingerprintV1 === true;
	if (Array.isArray(value))
		return `[${value.map((entry) => (legacy && entry === undefined ? "" : canonicalJson(entry, options))).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, entry]) => legacy || entry !== undefined)
			.sort(([a], [b]) =>
				legacy ? a.localeCompare(b) : a < b ? -1 : a > b ? 1 : 0,
			)
			.map(
				([key, entry]) =>
					`${JSON.stringify(key)}:${canonicalJson(entry, options)}`,
			)
			.join(",")}}`;
	}

	return JSON.stringify(value) ?? (legacy ? "undefined" : "null");
}
