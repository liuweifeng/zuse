import {
	AgentDefinition,
	Chat,
	type ChatId,
	DEFAULT_PERMISSION_MODE,
	DEFAULT_RUNTIME_MODE,
	type FolderId,
	Message,
	MessageContent,
	MessageId,
	type MessageRole,
	PermissionMode,
	ProviderThreadId,
	RuntimeMode,
	Session,
	SessionId,
	type SessionProviderThread,
	WorktreeArchiveSnapshot,
	type WorktreeId,
} from "@zuse/contracts";
import type {
	MessageReadRecord,
	SessionProviderThreadRecord,
} from "@zuse/domain/projectors/read-model";
import type { SqlSessionReadRecord } from "@zuse/domain/queries/sql-session-queries";
import { Option, Schema } from "effect";

interface ConversationRow {
	readonly id: string;
	readonly project_id: string;
	readonly title: string;
	readonly title_provenance?: "pending" | "automatic" | "manual";
	readonly worktree_id: string | null;
	readonly archived_at: string | null;
	readonly created_at: string;
	readonly updated_at: string;
}

export interface ChatRow extends ConversationRow {
	readonly active_session_id: string | null;
	readonly origin_session_id: string | null;
	readonly archived_worktree_json: string | null;
	readonly last_message_at: string | null;
	readonly last_user_message_at?: string | null;
	readonly last_read_at: string | null;
}

export type ArchivedWorktreeSnapshot = typeof WorktreeArchiveSnapshot.Type;
const decodeArchivedWorktreeSnapshot = Schema.decodeUnknownOption(
	Schema.fromJsonString(WorktreeArchiveSnapshot),
);
const decodeAgents = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Record(Schema.String, AgentDefinition)),
);
const decodeMessageContent = Schema.decodeUnknownSync(
	Schema.fromJsonString(MessageContent),
);

export const parseArchivedWorktreeSnapshot = (
	raw: string | null,
): ArchivedWorktreeSnapshot | null =>
	raw === null || raw.length === 0
		? null
		: Option.getOrNull(decodeArchivedWorktreeSnapshot(raw));

export const parseAgents = (
	raw: string | null,
): Readonly<Record<string, typeof AgentDefinition.Type>> | null =>
	raw === null || raw.length === 0 ? null : Option.getOrNull(decodeAgents(raw));

const runtimeModeFromRow = (raw: string): typeof RuntimeMode.Type =>
	Option.getOrElse(
		Schema.decodeUnknownOption(RuntimeMode)(raw),
		() => DEFAULT_RUNTIME_MODE,
	);

const permissionModeFromRow = (raw: string): typeof PermissionMode.Type =>
	Option.getOrElse(
		Schema.decodeUnknownOption(PermissionMode)(raw),
		() => DEFAULT_PERMISSION_MODE,
	);

const providerThreadFromParts = (input: {
	readonly id: string;
	readonly provider: string;
	readonly nativeThreadId: string;
	readonly nativeHeadId: string | null;
	readonly status: string;
	readonly firstTurnOrdinal: number | null;
	readonly lastTurnOrdinal: number | null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}): SessionProviderThread => {
	const provider = input.provider as Session["providerId"];
	return {
		id: ProviderThreadId.make(input.id),
		provider,
		nativeThreadRef: {
			provider,
			nativeId: input.nativeThreadId,
			strength: "strong",
		},
		nativeHeadRef:
			input.nativeHeadId === null
				? null
				: { provider, nativeId: input.nativeHeadId, strength: "weak" },
		status: input.status as SessionProviderThread["status"],
		firstTurnOrdinal: input.firstTurnOrdinal,
		lastTurnOrdinal: input.lastTurnOrdinal,
		createdAt: input.createdAt,
		updatedAt: input.updatedAt,
	};
};

export const providerThreadFromRecord = (
	record: SessionProviderThreadRecord | null,
): SessionProviderThread | null =>
	record === null
		? null
		: providerThreadFromParts({
				...record,
				createdAt: new Date(record.createdAt),
				updatedAt: new Date(record.updatedAt),
			});

export const sessionFromRecord = (record: SqlSessionReadRecord): Session =>
	Session.make({
		id: SessionId.make(record.sessionId),
		parentSessionId: record.parentSessionId
			? SessionId.make(record.parentSessionId)
			: null,
		projectId: record.projectId as FolderId,
		title: record.title,
		titleProvenance: record.titleProvenance ?? "manual",
		providerId: record.providerId as Session["providerId"],
		model: record.model,
		status: record.status,
		archivedAt: record.archivedAt === null ? null : new Date(record.archivedAt),
		providerThread: providerThreadFromRecord(record.activeProviderThread),
		runtimeMode: runtimeModeFromRow(record.runtimeMode),
		worktreeId:
			record.worktreeId === null ? null : (record.worktreeId as WorktreeId),
		chatId: record.chatId as ChatId,
		forkedFromSessionId:
			record.forkedFromSessionId === null
				? null
				: SessionId.make(record.forkedFromSessionId),
		forkedFromMessageId:
			record.forkedFromMessageId === null
				? null
				: MessageId.make(record.forkedFromMessageId),
		permissionMode: permissionModeFromRow(record.permissionMode),
		toolSearch: record.toolSearch,
		createdAt: new Date(record.createdAt),
		updatedAt: new Date(record.updatedAt),
	});

export const chatFromRow = (row: ChatRow): Chat =>
	Chat.make({
		id: row.id as ChatId,
		projectId: row.project_id as FolderId,
		worktreeId:
			row.worktree_id === null ? null : (row.worktree_id as WorktreeId),
		title: row.title,
		titleProvenance: row.title_provenance ?? "manual",
		activeSessionId:
			row.active_session_id === null
				? null
				: SessionId.make(row.active_session_id),
		originSessionId:
			row.origin_session_id === null
				? null
				: SessionId.make(row.origin_session_id),
		archivedAt: row.archived_at === null ? null : new Date(row.archived_at),
		lastUserMessageAt:
			row.last_user_message_at == null
				? null
				: new Date(row.last_user_message_at),
		lastMessageAt:
			row.last_message_at === null ? null : new Date(row.last_message_at),
		lastReadAt: row.last_read_at === null ? null : new Date(row.last_read_at),
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.updated_at),
	});

export const messageFromRecord = (record: MessageReadRecord): Message =>
	Message.make({
		id: MessageId.make(record.messageId),
		sessionId: SessionId.make(record.sessionId),
		role: record.role as MessageRole,
		content: decodeMessageContent(record.contentJson),
		createdAt: new Date(record.createdAt),
	});
