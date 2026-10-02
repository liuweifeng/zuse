/** Decodes persisted conversation read-model rows into public contracts. */
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

export interface SessionRow extends ConversationRow {
	readonly provider_id: string;
	readonly model: string;
	readonly status: string;
	readonly runtime_mode: string;
	readonly agents_json: string | null;
	readonly chat_id: string;
	readonly forked_from_session_id: string | null;
	readonly forked_from_message_id: string | null;
	readonly permission_mode: string;
	readonly tool_search: number;
	readonly pt_id?: string | null;
	readonly pt_provider?: string | null;
	readonly pt_native_thread_id?: string | null;
	readonly pt_native_head_id?: string | null;
	readonly pt_status?: string | null;
	readonly pt_first_turn_ordinal?: number | null;
	readonly pt_last_turn_ordinal?: number | null;
	readonly pt_created_at?: string | null;
	readonly pt_updated_at?: string | null;
}

/**
 * Columns of `sessions` joined with the active provider thread, for hand
 * written session queries. Alias the table as `s`.
 */
export const PROVIDER_THREAD_ROW_COLUMNS = `p.id AS pt_id, p.provider AS pt_provider, p.native_thread_id AS pt_native_thread_id,
	p.native_head_id AS pt_native_head_id, p.status AS pt_status,
	p.first_turn_ordinal AS pt_first_turn_ordinal, p.last_turn_ordinal AS pt_last_turn_ordinal,
	p.created_at AS pt_created_at, p.updated_at AS pt_updated_at`;
export const SESSION_ROW_COLUMNS = `s.id, s.project_id, s.title, s.title_provenance,
	s.provider_id, s.model, s.status, s.archived_at, s.runtime_mode, s.agents_json,
	s.worktree_id, s.chat_id, s.forked_from_session_id, s.forked_from_message_id,
	s.permission_mode, s.tool_search, s.created_at, s.updated_at,
	${PROVIDER_THREAD_ROW_COLUMNS}`;
export const SESSION_ROW_FROM = `FROM sessions s
	LEFT JOIN session_provider_threads p ON p.id = s.active_provider_thread_id`;

export interface ChatRow extends ConversationRow {
	readonly active_session_id: string | null;
	readonly origin_session_id: string | null;
	readonly archived_worktree_json: string | null;
	readonly last_message_at: string | null;
	readonly last_user_message_at?: string | null;
	readonly last_read_at: string | null;
}

export interface MessageRow {
	readonly id: string;
	readonly session_id: string;
	readonly role: string;
	readonly kind: string;
	readonly content_json: string;
	readonly parent_item_id: string | null;
	readonly created_at: string;
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

const providerThreadFromRow = (
	row: SessionRow,
): SessionProviderThread | null =>
	row.pt_id == null ||
	row.pt_provider == null ||
	row.pt_native_thread_id == null ||
	row.pt_status == null
		? null
		: providerThreadFromParts({
				id: row.pt_id,
				provider: row.pt_provider,
				nativeThreadId: row.pt_native_thread_id,
				nativeHeadId: row.pt_native_head_id ?? null,
				status: row.pt_status,
				firstTurnOrdinal: row.pt_first_turn_ordinal ?? null,
				lastTurnOrdinal: row.pt_last_turn_ordinal ?? null,
				createdAt: new Date(row.pt_created_at ?? row.created_at),
				updatedAt: new Date(row.pt_updated_at ?? row.updated_at),
			});

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

export const sessionFromRow = (row: SessionRow): Session =>
	Session.make({
		id: SessionId.make(row.id),
		projectId: row.project_id as FolderId,
		title: row.title,
		titleProvenance: row.title_provenance ?? "manual",
		providerId: row.provider_id as Session["providerId"],
		model: row.model,
		status: row.status as Session["status"],
		archivedAt: row.archived_at === null ? null : new Date(row.archived_at),
		providerThread: providerThreadFromRow(row),
		runtimeMode: runtimeModeFromRow(row.runtime_mode),
		worktreeId:
			row.worktree_id === null ? null : (row.worktree_id as WorktreeId),
		chatId: row.chat_id as ChatId,
		forkedFromSessionId:
			row.forked_from_session_id === null
				? null
				: SessionId.make(row.forked_from_session_id),
		forkedFromMessageId:
			row.forked_from_message_id === null
				? null
				: MessageId.make(row.forked_from_message_id),
		permissionMode: permissionModeFromRow(row.permission_mode),
		toolSearch: row.tool_search === 1,
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.updated_at),
	});

export const sessionFromRecord = (record: SqlSessionReadRecord): Session =>
	Session.make({
		id: SessionId.make(record.sessionId),
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

const normalizeMessageContent = (content: MessageContent): MessageContent =>
	content;

export const messageFromRow = (row: MessageRow): Message =>
	Message.make({
		id: MessageId.make(row.id),
		sessionId: SessionId.make(row.session_id),
		role: row.role as MessageRole,
		content: normalizeMessageContent(decodeMessageContent(row.content_json)),
		createdAt: new Date(row.created_at),
	});

export const messageFromRecord = (record: MessageReadRecord): Message =>
	Message.make({
		id: MessageId.make(record.messageId),
		sessionId: SessionId.make(record.sessionId),
		role: record.role as MessageRole,
		content: normalizeMessageContent(decodeMessageContent(record.contentJson)),
		createdAt: new Date(record.createdAt),
	});
