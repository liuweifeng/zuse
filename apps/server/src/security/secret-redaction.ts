const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
	[/\b(Bearer\s+)[^\s]+/gi, "$1[REDACTED]"],
	[/([?&])[^=\s]+=[^&\s]+/g, "$1[REDACTED]"],
	[
		/\b(?:sk|ghp|github_pat|xox[abprs])[-_][A-Za-z0-9._-]{8,}\b/gi,
		"[REDACTED]",
	],
	[
		/\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|credential)[A-Za-z0-9_]*)\s*[:=]\s*["']?[^\s"',;]+/gi,
		"$1=[REDACTED]",
	],
];

export const redactSecretText = (value: string): string => {
	let result = value;
	for (const [pattern, replacement] of SECRET_PATTERNS)
		result = result.replace(pattern, replacement);
	return result;
};
