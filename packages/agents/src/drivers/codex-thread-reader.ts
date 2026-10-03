import type { ProviderTurnReference } from "@zuse/contracts";
import type { Thread } from "./codex/generated/v2/Thread.ts";
import type { ThreadReadResponse } from "./codex/generated/v2/ThreadReadResponse.ts";
import type { Turn } from "./codex/generated/v2/Turn.ts";
import type { CodexAppServerClient } from "./codex-app-server-client.ts";

/** A failed read is not evidence that an execution did not happen. */
export class CodexThreadReadError extends Error {
	constructor(readonly reason: "read_failed" | "invalid_response") {
		super(`Native transcript inspection failed: ${reason}`);
		this.name = "CodexThreadReadError";
	}
}

type Reader = Pick<CodexAppServerClient, "request">;

/** Read-only inspection: never resumes a thread or submits provider input. */
export const readCodexThread = async (
	client: Reader,
	threadId: string,
): Promise<Thread> => {
	if (threadId.length === 0) throw new CodexThreadReadError("invalid_response");
	let response: ThreadReadResponse;
	try {
		response = await client.request<ThreadReadResponse>(
			"thread/read",
			{ threadId, includeTurns: true },
			{ timeoutMs: 10_000 },
		);
	} catch {
		// Transport errors may contain credentials or local transcript content.
		throw new CodexThreadReadError("read_failed");
	}
	if (
		response?.thread?.id !== threadId ||
		!Array.isArray(response.thread.turns)
	)
		throw new CodexThreadReadError("invalid_response");
	return response.thread;
};

export type CodexTurnEvidence =
	| { readonly kind: "missing" }
	| { readonly kind: "incomplete"; readonly reason?: "native_children" }
	| { readonly kind: "running" }
	| {
			readonly kind: "terminal";
			readonly turn: Turn & {
				readonly status: "completed" | "interrupted" | "failed";
			};
	  };

/** Parent activity/status snapshots do not identify a complete exact child turn.
 * Until those child transcripts are reconstructed, they cannot prove root completion.
 */
export const codexTurnRequiresChildRecovery = (turn: {
	readonly items: ReadonlyArray<unknown>;
}): boolean =>
	turn.items.some(
		(item) =>
			item !== null &&
			typeof item === "object" &&
			"type" in item &&
			(item.type === "collabAgentToolCall" || item.type === "subAgentActivity"),
	);

/** Only an exact native identity with full terminal output can prove completion. */
export const readCodexTurnEvidence = async (
	client: Reader,
	reference: ProviderTurnReference,
): Promise<CodexTurnEvidence> => {
	if (reference.provider !== "codex" || reference.nativeTurnId.length === 0)
		throw new CodexThreadReadError("invalid_response");
	const thread = await readCodexThread(client, reference.nativeThreadId);
	const matches = thread.turns.filter(
		(turn) => turn?.id === reference.nativeTurnId,
	);
	if (matches.length === 0) return { kind: "missing" };
	const turn = matches[0];
	if (matches.length !== 1 || turn === undefined || !Array.isArray(turn.items))
		throw new CodexThreadReadError("invalid_response");
	if (turn.itemsView !== "full") return { kind: "incomplete" };
	switch (turn.status) {
		case "inProgress":
			return { kind: "running" };
		case "completed":
		case "interrupted":
		case "failed":
			if (codexTurnRequiresChildRecovery(turn))
				return { kind: "incomplete", reason: "native_children" };
			return { kind: "terminal", turn: { ...turn, status: turn.status } };
		default:
			throw new CodexThreadReadError("invalid_response");
	}
};
