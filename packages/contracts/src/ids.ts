import { Schema } from "effect";

const TrimmedNonEmptyString = Schema.Trim.check(Schema.isNonEmpty());

const makeEntityId = <Brand extends string>(brand: Brand) =>
	TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const FolderId = makeEntityId("FolderId");
export type FolderId = typeof FolderId.Type;

export const PtyId = makeEntityId("PtyId");
export type PtyId = typeof PtyId.Type;

export const PtyOwnerId = makeEntityId("PtyOwnerId");
export type PtyOwnerId = typeof PtyOwnerId.Type;

export const AgentSessionId = makeEntityId("AgentSessionId");
export type AgentSessionId = typeof AgentSessionId.Type;

export const AgentTurnId = makeEntityId("AgentTurnId");
export type AgentTurnId = typeof AgentTurnId.Type;

export const AgentItemId = makeEntityId("AgentItemId");
export type AgentItemId = typeof AgentItemId.Type;

export const MessageId = makeEntityId("MessageId");
export type MessageId = typeof MessageId.Type;

export const WorktreeId = makeEntityId("WorktreeId");
export type WorktreeId = typeof WorktreeId.Type;

export const ChatId = makeEntityId("ChatId");
export type ChatId = typeof ChatId.Type;

export const EnvironmentId = makeEntityId("EnvironmentId");
export type EnvironmentId = typeof EnvironmentId.Type;

export const AuthTokenId = makeEntityId("AuthTokenId");
export type AuthTokenId = typeof AuthTokenId.Type;

export const CommandId = makeEntityId("CommandId");
export type CommandId = typeof CommandId.Type;

export const EventId = makeEntityId("EventId");
export type EventId = typeof EventId.Type;

// Agent Engine ids. App ids are identity; provider-native ids are carried only
// as `ProviderRef` values on the entities in `agent-engine.ts`.

export const AttemptId = makeEntityId("AttemptId");
export type AttemptId = typeof AttemptId.Type;

export const StepId = makeEntityId("StepId");
export type StepId = typeof StepId.Type;

/**
 * A live provider process/runtime. Distinct from `AgentSessionId`, which names
 * the app-side session: one app session can be backed by many provider
 * sessions over its lifetime.
 */
export const ProviderSessionId = makeEntityId("ProviderSessionId");
export type ProviderSessionId = typeof ProviderSessionId.Type;

export const ProviderThreadId = makeEntityId("ProviderThreadId");
export type ProviderThreadId = typeof ProviderThreadId.Type;

export const ProviderTurnId = makeEntityId("ProviderTurnId");
export type ProviderTurnId = typeof ProviderTurnId.Type;

export const InputRequestId = makeEntityId("InputRequestId");
export type InputRequestId = typeof InputRequestId.Type;

export const TimelineItemId = makeEntityId("TimelineItemId");
export type TimelineItemId = typeof TimelineItemId.Type;

export const ContextLinkId = makeEntityId("ContextLinkId");
export type ContextLinkId = typeof ContextLinkId.Type;

export const ContextHandoffId = makeEntityId("ContextHandoffId");
export type ContextHandoffId = typeof ContextHandoffId.Type;

export const CheckpointScopeId = makeEntityId("CheckpointScopeId");
export type CheckpointScopeId = typeof CheckpointScopeId.Type;

export const CheckpointId = makeEntityId("CheckpointId");
export type CheckpointId = typeof CheckpointId.Type;

export const JobId = makeEntityId("JobId");
export type JobId = typeof JobId.Type;
