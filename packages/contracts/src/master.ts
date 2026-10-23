import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { ProviderId } from "./agent.ts";
import { GitPrInfo } from "./git.ts";
import { Chat, MessageOrigin, Session } from "./session.ts";

export const MasterRepository = Schema.Struct({
	environmentId: Schema.String,
	folderId: Schema.String,
	name: Schema.String,
});
export type MasterRepository = typeof MasterRepository.Type;
export const MasterWorker = Schema.Struct({
	environmentId: Schema.String,
	folderId: Schema.String,
	chatId: Schema.String,
	sessionId: Schema.String,
	objective: Schema.String,
	state: Schema.Literals(["active", "paused", "done"]),
	followUps: Schema.Number,
	lastEventSequence: Schema.Number,
});
export type MasterWorker = typeof MasterWorker.Type;
export const MasterEntry = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literals(["todo", "decision", "note"]),
	text: Schema.String,
	status: Schema.Literals(["open", "done"]),
	author: Schema.String,
	updatedAt: Schema.Number,
});
export type MasterEntry = typeof MasterEntry.Type;
export const MasterArtifact = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	kind: Schema.Literals(["markdown", "screen"]),
	version: Schema.Number,
	pinned: Schema.Boolean,
	author: Schema.String,
	updatedAt: Schema.Number,
});
export type MasterArtifact = typeof MasterArtifact.Type;
export const MasterConversation = Schema.Struct({
	chatId: Schema.String,
	sessionId: Schema.String,
	environmentId: Schema.String,
	createdAt: Schema.Number,
	checkpoint: Schema.String,
});
export const MasterModelProfile = Schema.Struct({
	id: Schema.String,
	task: Schema.String,
	providerId: ProviderId,
	model: Schema.String,
});
export type MasterModelProfile = typeof MasterModelProfile.Type;
/** Identifiers of the Master mascots the renderer can draw. */
export const MASTER_MASCOTS = [
	"daemon",
	"nib",
	"ping",
	"fuzz",
	"cache",
] as const;
/** Named palette slots; the renderer owns the actual colours. */
export const MASTER_MASCOT_COLORS = [
	"coral",
	"yellow",
	"green",
	"lime",
	"violet",
	"teal",
	"blue",
	"pink",
] as const;
export const MasterAvatar = Schema.Struct({
	mascot: Schema.Literals(MASTER_MASCOTS),
	color: Schema.Literals(MASTER_MASCOT_COLORS),
});
export type MasterAvatar = typeof MasterAvatar.Type;

/** Bounds enforced on `MasterSettings` by the server and mirrored by the UI. */
export const MASTER_SETTINGS_LIMITS = {
	nameLength: 120,
	skills: 16,
	skillLength: 256,
	modelProfiles: 12,
	profileTaskLength: 120,
	profileModelLength: 160,
	maxConcurrent: { min: 1, max: 32 },
	maxFollowUps: { min: 0, max: 20 },
	instructionsLength: 32_000,
} as const;

export const MasterSettings = Schema.Struct({
	name: Schema.String,
	providerId: ProviderId,
	model: Schema.String,
	instructions: Schema.String,
	skills: Schema.Array(Schema.String),
	modelGuidance: Schema.String,
	modelProfiles: Schema.optional(Schema.Array(MasterModelProfile)),
	maxConcurrent: Schema.Number,
	maxFollowUps: Schema.Number,
	/** Older Masters have none; the renderer derives one from the id. */
	avatar: Schema.optional(MasterAvatar),
});
export type MasterSettings = typeof MasterSettings.Type;
/** Learned knowledge is data, separate from user policy and execution state. */
export const MasterMemorySource = Schema.Struct({
	entryId: Schema.String,
	fingerprint: Schema.String,
});
export type MasterMemorySource = typeof MasterMemorySource.Type;
export const MasterMemoryTopic = Schema.Struct({
	path: Schema.String,
	title: Schema.String,
	summary: Schema.String,
	version: Schema.Number,
	sources: Schema.Array(MasterMemorySource),
	author: Schema.String,
	updatedAt: Schema.Number,
	archived: Schema.Boolean,
});
export type MasterMemoryTopic = typeof MasterMemoryTopic.Type;
export const MasterMemoryPage = Schema.Struct({
	content: Schema.String,
	topic: MasterMemoryTopic,
	evidence: Schema.Array(MasterEntry),
});
export type MasterMemoryPage = typeof MasterMemoryPage.Type;
export const MasterMemoryConfig = Schema.Struct({
	automatic: Schema.Boolean,
	providerId: ProviderId,
	model: Schema.String,
});
export const MasterMemory = Schema.Struct({
	revision: Schema.Number,
	topics: Schema.Array(MasterMemoryTopic),
	consumed: Schema.Array(MasterMemorySource),
	config: Schema.optional(MasterMemoryConfig),
	run: Schema.NullOr(
		Schema.Struct({
			id: Schema.String,
			batchKey: Schema.optional(Schema.String),
			state: Schema.Literals([
				"queued",
				"running",
				"done",
				"failed",
				"cancelled",
			]),
			error: Schema.NullOr(Schema.String),
			updatedAt: Schema.Number,
		}),
	),
});
export type MasterMemory = typeof MasterMemory.Type;

export const Master = Schema.Struct({
	id: Schema.String,
	revision: Schema.Number,
	generation: Schema.Number,
	accountManaged: Schema.Boolean,
	homeEnvironmentId: Schema.String,
	workspaceId: Schema.String,
	status: Schema.Literals(["active", "paused", "stopped", "moving"]),
	settings: MasterSettings,
	repositories: Schema.Array(MasterRepository),
	workers: Schema.Array(MasterWorker),
	conversations: Schema.Array(MasterConversation),
	activeSessionId: Schema.NullOr(Schema.String),
	coordinatorEventSequence: Schema.Number,
	entries: Schema.Array(MasterEntry),
	memory: Schema.optional(MasterMemory),
	artifacts: Schema.Array(MasterArtifact),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
});
export type Master = typeof Master.Type;

export class MasterError extends Schema.TaggedErrorClass<MasterError>()(
	"MasterError",
	{ reason: Schema.String },
) {
	get message() {
		return this.reason;
	}
}

export const MasterChatSummary = Schema.Struct({
	repository: MasterRepository,
	chat: Chat,
	sessions: Schema.Array(Session),
	pr: Schema.NullOr(GitPrInfo),
	stale: Schema.Boolean,
	offline: Schema.Boolean,
	busySessionIds: Schema.Array(Schema.String),
	blockedSessionIds: Schema.Array(Schema.String),
});
export type MasterChatSummary = typeof MasterChatSummary.Type;
export const MasterCapabilities = Schema.Struct({
	crossEnvironment: Schema.Boolean,
	homeTransfer: Schema.Boolean,
	/** Disabled until generated content has enforceable network isolation. */
	generatedScreens: Schema.optional(Schema.Boolean),
});
export type MasterCapabilities = typeof MasterCapabilities.Type;
export const MasterSnapshot = Schema.Struct({
	/** Missing on older servers; clients must treat missing capabilities as disabled. */
	capabilities: Schema.optional(MasterCapabilities),
	master: Master,
	coordinator: Schema.NullOr(Session),
	workspacePath: Schema.String,
	coordinatorMessageCount: Schema.Number,
	chats: Schema.Array(MasterChatSummary),
	unavailableEnvironments: Schema.Array(Schema.String),
	pendingActions: Schema.Array(
		Schema.Struct({
			commandId: Schema.String,
			kind: Schema.String,
			state: Schema.String,
		}),
	),
});
export type MasterSnapshot = typeof MasterSnapshot.Type;

export const MasterAction = Schema.Union([
	Schema.TaggedStruct("memoryConfig", { config: MasterMemoryConfig }),
	Schema.TaggedStruct("dream", {}),
	Schema.TaggedStruct("cancelDream", {}),
	Schema.TaggedStruct("restoreMemory", {
		path: Schema.String,
		version: Schema.Number,
		expectedVersion: Schema.Number,
	}),
	Schema.TaggedStruct("remember", {
		path: Schema.String,
		title: Schema.String,
		summary: Schema.String,
		content: Schema.String,
		sources: Schema.Array(MasterMemorySource),
		expectedVersion: Schema.Number,
		archived: Schema.Boolean,
	}),

	Schema.TaggedStruct("configure", {
		settings: MasterSettings,
		repositories: Schema.Array(MasterRepository),
		expectedRevision: Schema.Number,
	}),
	Schema.TaggedStruct("renew", {}),
	/** Repository bindings only; unlike `configure`, keeps the current conversation. */
	Schema.TaggedStruct("repositories", {
		repositories: Schema.Array(MasterRepository),
	}),
	/** Name and mascot only; unlike `configure`, keeps the current conversation. */
	Schema.TaggedStruct("appearance", {
		name: Schema.String,
		avatar: MasterAvatar,
	}),
	Schema.TaggedStruct("instruct", { text: Schema.String }),
	Schema.TaggedStruct("move", { environmentId: Schema.String }),
	Schema.TaggedStruct("control", {
		status: Schema.Literals(["active", "paused", "stopped"]),
	}),
	Schema.TaggedStruct("entry", {
		id: Schema.String,
		kind: MasterEntry.fields.kind,
		text: Schema.String,
		status: MasterEntry.fields.status,
	}),
	Schema.TaggedStruct("publish", {
		id: Schema.String,
		title: Schema.String,
		kind: MasterArtifact.fields.kind,
		content: Schema.String,
		expectedVersion: Schema.Number,
		pinned: Schema.Boolean,
	}),
	Schema.TaggedStruct("delegate", {
		environmentId: Schema.String,
		folderId: Schema.String,
		task: Schema.String,
		title: Schema.String,
		providerId: ProviderId,
		model: Schema.String,
		chatId: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("message", {
		environmentId: Schema.String,
		sessionId: Schema.String,
		text: Schema.String,
	}),
	Schema.TaggedStruct("interrupt", {
		environmentId: Schema.String,
		sessionId: Schema.String,
	}),
	Schema.TaggedStruct("worker", {
		environmentId: Schema.String,
		sessionId: Schema.String,
		state: MasterWorker.fields.state,
	}),
]);
export type MasterAction = typeof MasterAction.Type;

export const MastersListRpc = Rpc.make("masters.list", {
	payload: Schema.Struct({}),
	success: Schema.Array(Master),
	error: MasterError,
});
export const MastersGetRpc = Rpc.make("masters.get", {
	payload: Schema.Struct({ masterId: Schema.String }),
	success: MasterSnapshot,
	error: MasterError,
});
export const MastersCreateRpc = Rpc.make("masters.create", {
	payload: Schema.Struct({
		commandId: Schema.String,
		settings: MasterSettings,
		repositories: Schema.Array(MasterRepository),
	}),
	success: Master,
	error: MasterError,
});
export const MastersExecuteRpc = Rpc.make("masters.execute", {
	payload: Schema.Struct({
		masterId: Schema.String,
		commandId: Schema.String,
		action: MasterAction,
	}),
	success: Master,
	error: MasterError,
});
export const MastersArtifactRpc = Rpc.make("masters.artifact", {
	payload: Schema.Struct({
		masterId: Schema.String,
		artifactId: Schema.String,
		version: Schema.Number,
	}),
	success: Schema.Struct({ content: Schema.String }),
	error: MasterError,
});

/** Authenticated environment-to-environment operations, restricted to one repository. */
export const MasterTargetAction = Schema.Union([
	Schema.TaggedStruct("cancel", {
		commandId: Schema.String,
		targetSessionId: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("catalog", {}),
	Schema.TaggedStruct("read", { sessionId: Schema.String }),
	Schema.TaggedStruct("events", {
		sessionId: Schema.String,
		after: Schema.Number,
	}),
	Schema.TaggedStruct("delegate", {
		task: Schema.String,
		title: Schema.String,
		providerId: ProviderId,
		model: Schema.String,
		chatId: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("message", {
		sessionId: Schema.String,
		text: Schema.String,
	}),
	Schema.TaggedStruct("interrupt", { sessionId: Schema.String }),
]);
export type MasterTargetAction = typeof MasterTargetAction.Type;
export const MasterTargetRequest = Schema.Struct({
	commandId: Schema.String,
	masterId: Schema.String,
	homeEnvironmentId: Schema.String,
	generation: Schema.Number,
	folderId: Schema.String,
	action: MasterTargetAction,
	origin: Schema.optional(MessageOrigin),
});
export type MasterTargetRequest = typeof MasterTargetRequest.Type;
export const MasterTargetResult = Schema.Struct({
	chats: Schema.Array(MasterChatSummary),
	chatId: Schema.NullOr(Schema.String),
	sessionId: Schema.NullOr(Schema.String),
	text: Schema.String,
	events: Schema.Array(
		Schema.Struct({
			sequence: Schema.Number,
			type: Schema.String,
			payload: Schema.String,
		}),
	),
});
export type MasterTargetResult = typeof MasterTargetResult.Type;
export const MastersTargetRpc = Rpc.make("masters.target", {
	payload: MasterTargetRequest,
	success: MasterTargetResult,
	error: MasterError,
});

export const MasterOwnership = Schema.Struct({
	masterId: Schema.String,
	homeEnvironmentId: Schema.String,
	generation: Schema.Number,
	repositories: Schema.Array(MasterRepository),
});
export type MasterOwnership = typeof MasterOwnership.Type;
export const MasterAuthorityCommand = Schema.Union([
	Schema.TaggedStruct("read", {}),
	Schema.TaggedStruct("claim", {
		expectedGeneration: Schema.Number,
		homeEnvironmentId: Schema.String,
		repositories: Schema.Array(MasterRepository),
	}),
]);
export type MasterAuthorityCommand = typeof MasterAuthorityCommand.Type;

export const MasterTransfer = Schema.Struct({
	master: Master,
	commands: Schema.Array(
		Schema.Struct({
			command_id: Schema.String,
			fingerprint: Schema.String,
			result_json: Schema.NullOr(Schema.String),
			phase: Schema.String,
			created_at: Schema.Number,
			input_json: Schema.NullOr(Schema.String),
		}),
	),
	interruptions: Schema.Array(
		Schema.Struct({
			command_id: Schema.String,
			environment_id: Schema.String,
			folder_id: Schema.String,
			session_id: Schema.String,
		}),
	),
	artifacts: Schema.Array(
		Schema.Struct({
			artifactId: Schema.String,
			version: Schema.Number,
			content: Schema.String,
		}),
	),
	revisions: Schema.Array(Schema.String),
	transcripts: Schema.Array(
		Schema.Struct({ sessionId: Schema.String, markdown: Schema.String }),
	),
});
export type MasterTransfer = typeof MasterTransfer.Type;
export const MastersTransferRpc = Rpc.make("masters.transfer", {
	payload: Schema.Struct({
		commandId: Schema.String,
		transfer: MasterTransfer,
	}),
	success: Master,
	error: MasterError,
});
export const MastersActivateRpc = Rpc.make("masters.activate", {
	payload: Schema.Struct({ masterId: Schema.String, commandId: Schema.String }),
	success: Master,
	error: MasterError,
});

export const MastersTranscriptRpc = Rpc.make("masters.transcript", {
	payload: Schema.Struct({ masterId: Schema.String, sessionId: Schema.String }),
	success: Schema.Struct({ content: Schema.String }),
	error: MasterError,
});

export const MasterQuery = Schema.Union([
	Schema.TaggedStruct("memory", {
		path: Schema.optional(Schema.String),
		version: Schema.optional(Schema.Number),
		search: Schema.optional(Schema.String),
	}),

	Schema.TaggedStruct("state", {}),
	Schema.TaggedStruct("worker", {
		environmentId: Schema.String,
		sessionId: Schema.String,
	}),
	Schema.TaggedStruct("artifact", {
		artifactId: Schema.String,
		version: Schema.Number,
	}),
	Schema.TaggedStruct("report", { id: Schema.String, text: Schema.String }),
]);
export type MasterQuery = typeof MasterQuery.Type;
export const MastersWorkerQueryRpc = Rpc.make("masters.workerQuery", {
	payload: Schema.Struct({
		masterId: Schema.String,
		environmentId: Schema.String,
		sessionId: Schema.String,
		query: MasterQuery,
	}),
	success: Schema.Struct({ json: Schema.String }),
	error: MasterError,
});

/** Session-scoped agent entry point shared by the CLI and MCP router. */
export const MastersAgentRpc = Rpc.make("masters.agent", {
	payload: Schema.Struct({
		sessionId: Schema.String,
		commandJson: Schema.optional(Schema.String),
		readOnly: Schema.Boolean,
		commandId: Schema.optional(Schema.String),
	}),
	success: Schema.Struct({ json: Schema.String }),
	error: MasterError,
});

export const MastersWatchRpc = Rpc.make("masters.watch", {
	payload: Schema.Struct({ masterId: Schema.String }),
	success: MasterSnapshot,
	error: MasterError,
	stream: true,
});
export const MastersDirectoryRpc = Rpc.make("masters.directory", {
	payload: Schema.Struct({}),
	success: Schema.Array(Master),
	error: MasterError,
	stream: true,
});

/** Short-lived peer grants cannot authenticate to the ordinary application RPC. */
export const MasterPeerGrant = Schema.Struct({
	endpoint: Schema.String,
	token: Schema.String,
	expiresAt: Schema.Number,
});
export type MasterPeerGrant = typeof MasterPeerGrant.Type;
export const MasterPeerOperation = Schema.Union([
	Schema.TaggedStruct("probe", { masterId: Schema.String }),
	Schema.TaggedStruct("target", { input: MasterTargetRequest }),
	Schema.TaggedStruct("stage", {
		commandId: Schema.String,
		transfer: MasterTransfer,
	}),
	Schema.TaggedStruct("activate", {
		masterId: Schema.String,
		commandId: Schema.String,
	}),
	Schema.TaggedStruct("workerQuery", {
		masterId: Schema.String,
		environmentId: Schema.String,
		sessionId: Schema.String,
		query: MasterQuery,
	}),
]);
export type MasterPeerOperation = typeof MasterPeerOperation.Type;
