export type SessionStatus =
	| "booting"
	| "idle"
	| "running"
	| "closed"
	| "error"
	| "deleted";

export type SessionReadRecord = {
	readonly sessionId: string;
	readonly chatId: string;
	readonly projectId: string;
	readonly title: string | null;
	readonly titleProvenance: "pending" | "automatic" | "manual";
	readonly status: SessionStatus;
	readonly providerId: string | null;
	readonly model: string | null;
	/** The active provider-native thread, when one is bound. */
	readonly activeProviderThread: SessionProviderThreadRecord | null;
	readonly runtimeMode: string | null;
	readonly agentsJson: string | null;
	readonly worktreeId: string | null;
	readonly forkedFromSessionId: string | null;
	readonly forkedFromMessageId: string | null;
	readonly permissionMode: string | null;
	readonly toolSearch: boolean;
	readonly archivedAt: number | null;
	readonly deletedAt: number | null;
	readonly lastMessageAt: number | null;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type SessionProviderThreadRecord = {
	readonly id: string;
	readonly provider: string;
	readonly nativeThreadId: string;
	readonly nativeHeadId: string | null;
	readonly status: "not_loaded" | "idle" | "active" | "closed" | "error";
	readonly firstTurnOrdinal: number | null;
	readonly lastTurnOrdinal: number | null;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type MessageReadRecord = {
	readonly messageId: string;
	readonly sessionId: string;
	readonly turnId: string | null;
	readonly role: string;
	readonly kind: string;
	readonly contentJson: string;
	readonly parentItemId: string | null;
	readonly createdAt: number;
	readonly sequence: number;
	readonly checkpointRevision: number | null;
	readonly checkpointFinal: boolean | null;
};
