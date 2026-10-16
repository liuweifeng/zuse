import type { ModelMessage } from "ai";
import { HarnessCache, stableJson } from "./cache.ts";

export interface CompactionCheckpoint {
	readonly covered: number;
	readonly summary: string;
}
/** Cache estimates by immutable committed message identity; never retain duplicate prompt text. */
export class PromptCache {
	constructor(readonly cache = new HarnessCache()) {}
	private identities = new WeakMap<ModelMessage, number>();
	private nextIdentity = 0;
	private key(message: ModelMessage, model: string, kind: string): string {
		let id = this.identities.get(message);
		if (id === undefined) {
			id = this.nextIdentity++;
			this.identities.set(message, id);
		}
		return `${kind}:v1:${model}:${id}`;
	}

	estimate(messages: ModelMessage[], model: string): number {
		return messages.reduce((sum, message) => {
			const key = this.key(message, model, "estimate");
			const cached = this.cache.get(key);
			if (cached !== undefined) return sum + Number(cached);
			let imageTokens = 0;

			const estimated =
				message.role === "tool"
					? {
							...message,
							content: message.content.map((part) => {
								if (
									part.type !== "tool-result" ||
									part.output.type !== "content"
								)
									return part;
								return {
									...part,
									output: {
										...part.output,
										value: part.output.value.map((value) => {
											if (
												value.type !== "file" ||
												!value.mediaType.startsWith("image/")
											)
												return value;
											imageTokens += 8192;
											return {
												...value,
												data: { type: "data" as const, data: "" },
											};
										}),
									},
								};
							}),
						}
					: message.role === "user" && Array.isArray(message.content)
						? {
								...message,
								content: message.content.map((part) => {
									if (part.type !== "image") return part;
									imageTokens += 8192;
									return { ...part, image: "" };
								}),
							}
						: message;
			const estimate =
				Math.ceil(Buffer.byteLength(stableJson(estimated)) / 3) +
				8 +
				imageTokens;
			this.cache.set(key, String(estimate));
			return sum + estimate;
		}, 0);
	}
}
export const sharedPromptCache = new PromptCache();

export function renderHistory(
	history: ModelMessage[],
	checkpoint?: CompactionCheckpoint,
): ModelMessage[] {
	if (!checkpoint) return history.slice();
	const prefix = history
		.slice(0, checkpoint.covered)
		.filter((message) => message.role === "system");
	const task = history
		.slice(0, checkpoint.covered)
		.find((message) => message.role === "user");
	return [
		...prefix,
		...(task ? [task] : []),
		{
			role: "user",
			content: `Durable context summary:\n${checkpoint.summary}`,
		},
		...history.slice(checkpoint.covered),
	];
}
/** Split before a new user/model exchange, retaining the last two complete exchanges. */
export function compactionBoundary(history: ModelMessage[]): number {
	const boundaries = history.flatMap((message, index) =>
		message.role === "user" || message.role === "assistant" ? [index] : [],
	);
	return boundaries.length > 2 ? (boundaries[boundaries.length - 2] ?? 0) : 0;
}

/** Matches Codex ModelInfo: 90% auto-compaction cap, separate 95% usable window. */
export function contextLimits(
	windowTokens = 32_000,
	autoCompactTokenLimit?: number,
	effectivePercent = 95,
) {
	const window =
		Number.isSafeInteger(windowTokens) && windowTokens > 0
			? windowTokens
			: 32_000;
	const percent =
		Number.isFinite(effectivePercent) &&
		effectivePercent > 0 &&
		effectivePercent <= 100
			? effectivePercent
			: 95;
	const cap = Math.floor(window * 0.9);
	return {
		windowTokens: window,
		usableTokens: Math.floor((window * percent) / 100),
		compactAt:
			typeof autoCompactTokenLimit === "number" &&
			Number.isSafeInteger(autoCompactTokenLimit) &&
			autoCompactTokenLimit > 0
				? Math.min(cap, autoCompactTokenLimit)
				: cap,
	};
}
