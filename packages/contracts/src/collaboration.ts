import { Schema } from "effect";

/** Stable workspace author established by a trusted transport, never client claims. */
export const WorkspaceActor = Schema.Struct({
	subject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
	membershipId: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(128),
	),
});
export type WorkspaceActor = typeof WorkspaceActor.Type;

/** Sharing is resource access, independent of membership and billing authority. */
export const ChatAccessPermission = Schema.Literals(["view", "edit"]);
export type ChatAccessPermission = typeof ChatAccessPermission.Type;

export const ChatSharingDefaults = Schema.Struct({
	audience: Schema.Literals(["private", "organization"]),
	permission: ChatAccessPermission,
});
export type ChatSharingDefaults = typeof ChatSharingDefaults.Type;

export const ChatSharingPolicy = Schema.Struct({
	...ChatSharingDefaults.fields,

	revision: Schema.optional(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	),
	creatorSubject: Schema.NonEmptyString,

	creatorMembershipId: Schema.NonEmptyString,
	grants: Schema.Array(
		Schema.Struct({
			membershipId: Schema.NonEmptyString,
			permission: ChatAccessPermission,
		}),
	),
});
export type ChatSharingPolicy = typeof ChatSharingPolicy.Type;

export const ChatSharingUpdate = Schema.Struct({
	...ChatSharingDefaults.fields,
	grants: ChatSharingPolicy.fields.grants,
	expectedRevision: Schema.Number.check(
		Schema.isInt(),
		Schema.isGreaterThanOrEqualTo(0),
	),
});
export type ChatSharingUpdate = typeof ChatSharingUpdate.Type;

export const ChatSharingState = Schema.Struct({
	policy: ChatSharingPolicy,
	revision: Schema.Number,
	canManageSharing: Schema.Boolean,
});
export type ChatSharingState = typeof ChatSharingState.Type;
